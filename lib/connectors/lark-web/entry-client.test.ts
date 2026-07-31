/** @jest-environment jsdom */

import { resolveLarkEntry } from "./entry-client"
import { LARK_WEB_SESSION_STORAGE_KEY } from "./session"

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`
}

function seedSession(): string {
  const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, scope: "lark_web" })
  window.sessionStorage.setItem(LARK_WEB_SESSION_STORAGE_KEY, token)
  return token
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response
}

const ENTRY_TOKEN = fakeJwt({ scope: "lark_entry", adapter_id: "lk-1" })

describe("resolveLarkEntry", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.history.replaceState(null, "", "/lark/entry")
  })

  it("errors when no token rides the URL", async () => {
    expect(await resolveLarkEntry({ search: "", returnTo: "/x", apiBase: "" })).toEqual({
      kind: "error",
      code: "entry_missing",
    })
  })

  it("bounces to login when no session exists, using the token's adapter id", async () => {
    const outcome = await resolveLarkEntry({
      search: `?entry=${ENTRY_TOKEN}`,
      returnTo: "/lark/entry?entry=x",
      apiBase: "https://api.example",
    })
    expect(outcome).toEqual({
      kind: "login",
      loginUrl:
        "https://api.example/integrations/lark/web/login?adapter_id=lk-1&return_to=%2Flark%2Fentry%3Fentry%3Dx",
    })
  })

  it("resolves a personal entry token straight to navigation", async () => {
    const session = seedSession()
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/integrations/lark/entry/resolve")
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${session}`)
      expect(JSON.parse(String(init?.body))).toEqual({ entry: ENTRY_TOKEN })
      return jsonResponse(200, {
        status: "done",
        conversationKey: "lark:lk-1:oc_1",
        sessionId: "sess_9",
      })
    }) as unknown as typeof fetch
    const outcome = await resolveLarkEntry({
      search: `?entry=${ENTRY_TOKEN}`,
      returnTo: "/r",
      apiBase: "",
      fetchFn,
    })
    expect(outcome).toEqual({
      kind: "navigate",
      conversationKey: "lark:lk-1:oc_1",
      sessionId: "sess_9",
    })
  })

  it("maps deny statuses onto stable error codes", async () => {
    seedSession()
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [410, { error: "entry_expired" }, "entry_expired"],
      [409, { error: "entry_consumed" }, "entry_consumed"],
      [403, { error: "entry_principal_mismatch" }, "forbidden"],
      [403, { error: "principal_unbound" }, "unbound"],
      [400, { error: "entry_invalid" }, "resolve_failed"],
    ]
    for (const [status, body, code] of cases) {
      const fetchFn = jest.fn(async () => jsonResponse(status, body)) as unknown as typeof fetch
      const outcome = await resolveLarkEntry({
        search: `?entry=${ENTRY_TOKEN}`,
        returnTo: "/r",
        apiBase: "",
        fetchFn,
      })
      expect(outcome).toEqual({ kind: "error", code })
    }
  })

  it("drops a rejected session and restarts via login", async () => {
    seedSession()
    const fetchFn = jest.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch
    const outcome = await resolveLarkEntry({
      search: `?entry=${ENTRY_TOKEN}`,
      returnTo: "/r",
      apiBase: "",
      fetchFn,
    })
    expect(outcome.kind).toBe("login")
    expect(window.sessionStorage.getItem(LARK_WEB_SESSION_STORAGE_KEY)).toBeNull()
  })

  it("polls surface resolutions until the brain answers", async () => {
    seedSession()
    const surface = fakeJwt({ scope: "lark_surface", adapter_id: "lk-1" })
    let polls = 0
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes("/entry/resolve")) {
        return jsonResponse(202, { status: "pending", requestId: "req_1" })
      }
      polls += 1
      if (polls < 3) return jsonResponse(200, { status: "pending" })
      return jsonResponse(200, {
        status: "done",
        result: { conversationKey: "lark:lk-1:oc_9" },
      })
    }) as unknown as typeof fetch
    const outcome = await resolveLarkEntry({
      search: `?surface=${surface}`,
      returnTo: "/r",
      apiBase: "",
      fetchFn,
      pollIntervalMs: 1,
      pollBudgetMs: 20,
      sleep: async () => undefined,
    })
    expect(outcome).toEqual({ kind: "navigate", conversationKey: "lark:lk-1:oc_9" })
  })

  it("times out pending intents and surfaces membership denials", async () => {
    seedSession()
    const surface = fakeJwt({ scope: "lark_surface", adapter_id: "lk-1" })
    const pendingForever = jest.fn(async (url: string) =>
      url.includes("/entry/resolve")
        ? jsonResponse(202, { status: "pending", requestId: "req_1" })
        : jsonResponse(200, { status: "pending" })
    ) as unknown as typeof fetch
    expect(
      await resolveLarkEntry({
        search: `?surface=${surface}`,
        returnTo: "/r",
        apiBase: "",
        fetchFn: pendingForever,
        pollIntervalMs: 1,
        pollBudgetMs: 3,
        sleep: async () => undefined,
      })
    ).toEqual({ kind: "error", code: "timeout" })

    const denied = jest.fn(async (url: string) =>
      url.includes("/entry/resolve")
        ? jsonResponse(202, { status: "pending", requestId: "req_2" })
        : jsonResponse(200, { status: "error", error: "membership_denied" })
    ) as unknown as typeof fetch
    expect(
      await resolveLarkEntry({
        search: `?surface=${surface}`,
        returnTo: "/r",
        apiBase: "",
        fetchFn: denied,
        pollIntervalMs: 1,
        pollBudgetMs: 10,
        sleep: async () => undefined,
      })
    ).toEqual({ kind: "error", code: "forbidden" })
  })

  it("fails resolve_failed when the token payload carries no adapter id", async () => {
    // No session → login bounce needs adapter_id from the token; junk payload
    // cannot supply one.
    expect(
      await resolveLarkEntry({ search: "?entry=junk.token.sig", returnTo: "/r", apiBase: "" })
    ).toEqual({ kind: "error", code: "resolve_failed" })

    // Session rejected (401) with an undecodable token hits the same arm.
    seedSession()
    const rejecting = jest.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch
    expect(
      await resolveLarkEntry({
        search: "?entry=junk.token.sig",
        returnTo: "/r",
        apiBase: "",
        fetchFn: rejecting,
      })
    ).toEqual({ kind: "error", code: "resolve_failed" })
  })

  it("keeps polling across network errors until the budget runs out", async () => {
    seedSession()
    const surface = fakeJwt({ scope: "lark_surface", adapter_id: "lk-1" })
    let polls = 0
    const flaky = jest.fn(async (url: string) => {
      if (url.includes("/entry/resolve")) {
        return jsonResponse(202, { status: "pending", requestId: "req_n" })
      }
      polls += 1
      if (polls === 1) throw new Error("network blip")
      return jsonResponse(200, { status: "done", result: { conversationKey: "lark:lk-1:oc_2" } })
    }) as unknown as typeof fetch
    expect(
      await resolveLarkEntry({
        search: `?surface=${surface}`,
        returnTo: "/r",
        apiBase: "",
        fetchFn: flaky,
        pollIntervalMs: 1,
        pollBudgetMs: 10,
        sleep: async () => undefined,
      })
    ).toEqual({ kind: "navigate", conversationKey: "lark:lk-1:oc_2" })
  })
})
