/** @jest-environment jsdom */

import {
  extractMessageRefs,
  parseShortcutLaunch,
  pollLarkIntent,
  runLarkEntryFlow,
  runPlusCreateFlow,
  runShortcutImportFlow,
  submitLarkIntent,
} from "./intent-client"
import { LARK_WEB_SESSION_STORAGE_KEY } from "./session"

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`
}

function seedSession(): string {
  const token = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "lark_web",
    adapter_id: "lk-1",
  })
  window.sessionStorage.setItem(LARK_WEB_SESSION_STORAGE_KEY, token)
  return token
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState(null, "", "/lark/shortcut")
})

describe("parseShortcutLaunch", () => {
  it("reads direct params and both bdp_launch_query encodings", () => {
    expect(parseShortcutLaunch("?__trigger_id__=t1&adapter_id=lk-1&chat_id=oc_1")).toEqual({
      triggerId: "t1",
      adapterId: "lk-1",
      chatId: "oc_1",
    })
    const json = encodeURIComponent(JSON.stringify({ __trigger_id__: "t2" }))
    expect(parseShortcutLaunch(`?bdp_launch_query=${json}`).triggerId).toBe("t2")
    const nested = encodeURIComponent("__trigger_id__=t3&x=1")
    expect(parseShortcutLaunch(`?bdp_launch_query=${nested}`).triggerId).toBe("t3")
    expect(parseShortcutLaunch("").triggerId).toBeUndefined()
  })
})

describe("extractMessageRefs", () => {
  it("deep-scans plausible JSSDK shapes, dedupes, and caps at 20", () => {
    const detail = {
      actionSourceType: 1,
      detail: {
        chat_id: "oc_9",
        messages: [
          { message_id: "om_1", content: "a" },
          { openMessageId: "om_2" },
          { message_id: "om_1" },
        ],
      },
    }
    expect(extractMessageRefs(detail)).toEqual({ chatId: "oc_9", messageIds: ["om_1", "om_2"] })

    const flood = {
      items: Array.from({ length: 30 }, (_, i) => ({ message_id: `om_${i}` })),
    }
    expect(extractMessageRefs(flood).messageIds).toHaveLength(20)
    expect(extractMessageRefs(null)).toEqual({ chatId: undefined, messageIds: [] })
  })
})

describe("submitLarkIntent", () => {
  it("bounces to login without a session and clears a rejected one", async () => {
    const noSession = await submitLarkIntent({
      path: "/shortcut/import",
      body: {},
      adapterId: "lk-1",
      returnTo: "/lark/shortcut?x=1",
      apiBase: "https://api.example",
    })
    expect(noSession).toEqual({
      kind: "login",
      loginUrl:
        "https://api.example/integrations/lark/web/login?adapter_id=lk-1&return_to=%2Flark%2Fshortcut%3Fx%3D1",
    })

    seedSession()
    const rejecting = jest.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch
    const rejected = await submitLarkIntent({
      path: "/shortcut/import",
      body: {},
      adapterId: "lk-1",
      returnTo: "/r",
      apiBase: "",
      fetchFn: rejecting,
    })
    expect(rejected.kind).toBe("login")
    expect(window.sessionStorage.getItem(LARK_WEB_SESSION_STORAGE_KEY)).toBeNull()
  })

  it("POSTs the intent with the session and returns the requestId", async () => {
    const session = seedSession()
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/integrations/lark/shortcut/import")
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${session}`)
      expect(JSON.parse(String(init?.body)).chatId).toBe("oc_1")
      return jsonResponse(202, { status: "pending", requestId: "req_9" })
    }) as unknown as typeof fetch
    expect(
      await submitLarkIntent({
        path: "/shortcut/import",
        body: { chatId: "oc_1" },
        adapterId: "lk-1",
        returnTo: "/r",
        apiBase: "",
        fetchFn,
      })
    ).toEqual({ kind: "accepted", requestId: "req_9" })
  })
})

describe("pollLarkIntent", () => {
  it("resolves done results and surfaces brain errors", async () => {
    seedSession()
    let polls = 0
    const fetchFn = jest.fn(async () => {
      polls += 1
      if (polls < 2) return jsonResponse(200, { status: "pending" })
      return jsonResponse(200, { status: "done", result: { conversationKey: "lark:lk-1:oc_1" } })
    }) as unknown as typeof fetch
    expect(
      await pollLarkIntent({
        requestId: "req_1",
        apiBase: "",
        fetchFn,
        pollIntervalMs: 1,
        pollBudgetMs: 10,
        sleep: async () => undefined,
      })
    ).toEqual({ kind: "done", result: { conversationKey: "lark:lk-1:oc_1" } })

    const denied = jest.fn(async () =>
      jsonResponse(200, { status: "error", error: "membership_denied" })
    ) as unknown as typeof fetch
    expect(
      await pollLarkIntent({
        requestId: "req_2",
        apiBase: "",
        fetchFn: denied,
        pollIntervalMs: 1,
        pollBudgetMs: 5,
        sleep: async () => undefined,
      })
    ).toEqual({ kind: "error", code: "membership_denied" })
  })
})

describe("runShortcutImportFlow", () => {
  it("chains JSSDK detail → submit → poll → navigate", async () => {
    seedSession()
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes("/shortcut/import")) {
        return jsonResponse(202, { status: "pending", requestId: "req_f" })
      }
      return jsonResponse(200, {
        status: "done",
        result: { conversationKey: "lark:lk-1:oc_7", sessionId: "sess_7", imported: 3 },
      })
    }) as unknown as typeof fetch
    const outcome = await runShortcutImportFlow({
      search: "?__trigger_id__=t9&adapter_id=lk-1",
      returnTo: "/lark/shortcut",
      getTriggerDetail: async (trigger) => {
        expect(trigger).toBe("t9")
        return { chat_id: "oc_7", messages: [{ message_id: "om_1" }, { message_id: "om_2" }] }
      },
      apiBase: "",
      fetchFn,
      pollIntervalMs: 1,
      pollBudgetMs: 10,
      sleep: async () => undefined,
    })
    expect(outcome).toEqual({
      kind: "navigate",
      conversationKey: "lark:lk-1:oc_7",
      sessionId: "sess_7",
      imported: 3,
    })
  })

  it("fails fast on missing trigger, adapter, or selection", async () => {
    seedSession()
    expect(
      (
        await runShortcutImportFlow({
          search: "?adapter_id=lk-1",
          returnTo: "/r",
          getTriggerDetail: async () => ({}),
        })
      ).kind
    ).toBe("error")
    window.sessionStorage.clear()
    expect(
      await runShortcutImportFlow({
        search: "?__trigger_id__=t1",
        returnTo: "/r",
        getTriggerDetail: async () => ({}),
      })
    ).toEqual({ kind: "error", code: "adapter_missing" })
    seedSession()
    expect(
      await runShortcutImportFlow({
        search: "?__trigger_id__=t1&adapter_id=lk-1",
        returnTo: "/r",
        getTriggerDetail: async () => ({ nothing: true }),
        apiBase: "",
      })
    ).toEqual({ kind: "error", code: "no_messages_selected" })
  })

  it("passes login bounces through and rejects done results without a key", async () => {
    window.sessionStorage.clear()
    const bounced = await runShortcutImportFlow({
      search: "?__trigger_id__=t1&adapter_id=lk-1",
      returnTo: "/lark/shortcut",
      getTriggerDetail: async () => ({ chat_id: "oc_1", messages: [{ message_id: "om_1" }] }),
      apiBase: "https://api.example",
    })
    expect(bounced.kind).toBe("login")

    seedSession()
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes("/shortcut/import")) {
        return jsonResponse(202, { status: "pending", requestId: "req_bad" })
      }
      return jsonResponse(200, { status: "done", result: { unexpected: true } })
    }) as unknown as typeof fetch
    expect(
      await runShortcutImportFlow({
        search: "?__trigger_id__=t1&adapter_id=lk-1",
        returnTo: "/r",
        getTriggerDetail: async () => ({ chat_id: "oc_1", messages: [{ message_id: "om_1" }] }),
        apiBase: "",
        fetchFn,
        pollIntervalMs: 1,
        pollBudgetMs: 5,
        sleep: async () => undefined,
      })
    ).toEqual({ kind: "error", code: "intent_failed" })
  })
})

describe("runPlusCreateFlow", () => {
  const flow = (search: string, fetchFn: typeof fetch) =>
    runPlusCreateFlow({
      search,
      returnTo: "/lark/shortcut",
      apiBase: "https://api.example",
      fetchFn,
      pollIntervalMs: 1,
      pollBudgetMs: 10,
      sleep: async () => undefined,
    })

  it("submits the chat id and navigates to the bound conversation", async () => {
    seedSession()
    const fetchFn = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/plus/create")
        ? jsonResponse(202, { requestId: "req-1" })
        : jsonResponse(200, {
            status: "done",
            result: { conversationKey: "lark:lk-1:oc_1", sessionId: "sess_1" },
          })
    ) as unknown as typeof fetch

    const outcome = await flow("?adapter_id=lk-1&chat_id=oc_1", fetchFn)

    expect(outcome).toEqual({
      kind: "navigate",
      conversationKey: "lark:lk-1:oc_1",
      sessionId: "sess_1",
      imported: undefined,
    })
    const submit = (fetchFn as unknown as jest.Mock).mock.calls[0]
    expect(String(submit[0])).toBe("https://api.example/integrations/lark/plus/create")
    expect(JSON.parse(String(submit[1].body))).toEqual({ adapterId: "lk-1", chatId: "oc_1" })
  })

  it("falls back to the session's adapter id", async () => {
    seedSession()
    const fetchFn = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/plus/create")
        ? jsonResponse(202, { requestId: "req-1" })
        : jsonResponse(200, { status: "done", result: { conversationKey: "lark:lk-1:oc_2" } })
    ) as unknown as typeof fetch

    const outcome = await flow("?chat_id=oc_2", fetchFn)

    expect(outcome.kind).toBe("navigate")
    const submit = (fetchFn as unknown as jest.Mock).mock.calls[0]
    expect(JSON.parse(String(submit[1].body)).adapterId).toBe("lk-1")
  })

  it("reports chat_missing without calling the API", async () => {
    seedSession()
    const fetchFn = jest.fn() as unknown as typeof fetch
    expect(await flow("?adapter_id=lk-1", fetchFn)).toEqual({
      kind: "error",
      code: "chat_missing",
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("reads the chat id out of bdp_launch_query in both encodings", async () => {
    const json = encodeURIComponent(JSON.stringify({ chat_id: "oc_json" }))
    expect(parseShortcutLaunch(`?bdp_launch_query=${json}`).chatId).toBe("oc_json")
    const nested = encodeURIComponent("open_chat_id=oc_nested")
    expect(parseShortcutLaunch(`?bdp_launch_query=${nested}`).chatId).toBe("oc_nested")
  })
})

describe("runLarkEntryFlow", () => {
  it("routes to the plus-create branch when there is no trigger code", async () => {
    seedSession()
    const fetchFn = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/plus/create")
        ? jsonResponse(202, { requestId: "req-1" })
        : jsonResponse(200, { status: "done", result: { conversationKey: "lark:lk-1:oc_1" } })
    ) as unknown as typeof fetch

    const outcome = await runLarkEntryFlow({
      search: "?adapter_id=lk-1&chat_id=oc_1",
      returnTo: "/lark/shortcut",
      apiBase: "https://api.example",
      fetchFn,
      getTriggerDetail: async () => {
        throw new Error("the + menu must never reach the JSSDK")
      },
      pollIntervalMs: 1,
      pollBudgetMs: 10,
      sleep: async () => undefined,
    })

    expect(outcome.kind).toBe("navigate")
    expect(String((fetchFn as unknown as jest.Mock).mock.calls[0][0])).toContain("/plus/create")
  })

  it("routes to the import branch when a trigger code is present", async () => {
    seedSession()
    const fetchFn = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/shortcut/import")
        ? jsonResponse(202, { requestId: "req-1" })
        : jsonResponse(200, { status: "done", result: { conversationKey: "lark:lk-1:oc_1" } })
    ) as unknown as typeof fetch

    const outcome = await runLarkEntryFlow({
      search: "?adapter_id=lk-1&__trigger_id__=t1",
      returnTo: "/lark/shortcut",
      apiBase: "https://api.example",
      fetchFn,
      getTriggerDetail: async () => ({ chat_id: "oc_1", message_id: "om_1" }),
      pollIntervalMs: 1,
      pollBudgetMs: 10,
      sleep: async () => undefined,
    })

    expect(outcome.kind).toBe("navigate")
    expect(String((fetchFn as unknown as jest.Mock).mock.calls[0][0])).toContain("/shortcut/import")
  })
})
