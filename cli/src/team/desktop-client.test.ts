import {
  fetchDesktopTeamRunStatus,
  listDesktopTeams,
  startDesktopTeamRun,
  TEAMS_LIST_PATH,
  TEAMS_RUN_PATH,
  TEAMS_RUN_STATUS_PATH,
} from "./desktop-client"
import { DEV_TOKEN_HEADER } from "../handoff/client"

const endpoint = { baseUrl: "http://127.0.0.1:4242", devToken: "tok" }

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe("listDesktopTeams", () => {
  it("returns null when no desktop endpoint resolves", async () => {
    expect(await listDesktopTeams({ endpoint: null, fetch: jest.fn() })).toBeNull()
  })

  it("unwraps the double envelope and returns the rows", async () => {
    const teams = [{ id: "t1", name: "A", status: "idle", objective: "o", teammateCount: 2 }]
    const doFetch = jest.fn(async () => jsonResponse({ ok: true, result: { ok: true, teams } }))
    const out = await listDesktopTeams({ endpoint, fetch: doFetch as unknown as typeof fetch })
    expect(out).toEqual(teams)
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}${TEAMS_LIST_PATH}`)
    expect((init.headers as Record<string, string>)[DEV_TOKEN_HEADER]).toBe("tok")
  })

  it("returns null on HTTP or renderer failure", async () => {
    const httpErr = jest.fn(async () => jsonResponse({}, false))
    expect(
      await listDesktopTeams({ endpoint, fetch: httpErr as unknown as typeof fetch })
    ).toBeNull()
    const rendererErr = jest.fn(async () =>
      jsonResponse({ ok: true, result: { ok: false, error: "x" } })
    )
    expect(
      await listDesktopTeams({ endpoint, fetch: rendererErr as unknown as typeof fetch })
    ).toBeNull()
  })
})

describe("startDesktopTeamRun", () => {
  it("POSTs the teamId and reports success", async () => {
    const doFetch = jest.fn(async () =>
      jsonResponse({ ok: true, result: { ok: true, teamId: "t1", started: true } })
    )
    const out = await startDesktopTeamRun("t1", {
      endpoint,
      fetch: doFetch as unknown as typeof fetch,
    })
    expect(out).toEqual({ ok: true })
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}${TEAMS_RUN_PATH}`)
    expect(JSON.parse(String(init.body))).toEqual({ teamId: "t1" })
  })

  it("surfaces the renderer error and the unreachable case distinctly", async () => {
    const rendererErr = jest.fn(async () =>
      jsonResponse({ ok: true, result: { ok: false, error: "team t1 not found" } })
    )
    expect(
      await startDesktopTeamRun("t1", { endpoint, fetch: rendererErr as unknown as typeof fetch })
    ).toEqual({ ok: false, error: "team t1 not found" })

    expect(await startDesktopTeamRun("t1", { endpoint: null, fetch: jest.fn() })).toEqual({
      ok: false,
      error: "desktop unreachable",
    })
  })
})

describe("fetchDesktopTeamRunStatus", () => {
  it("passes the cursor and unwraps the status projection", async () => {
    const status = {
      ok: true,
      run: { runId: "r1", status: "running", startedAt: 5 },
      events: [{ ts: 6, type: "run_log", message: "hi" }],
    }
    const doFetch = jest.fn(async () => jsonResponse({ ok: true, result: status }))
    const out = await fetchDesktopTeamRunStatus("t1", 5, {
      endpoint,
      fetch: doFetch as unknown as typeof fetch,
    })
    expect(out).toMatchObject({ run: { runId: "r1" } })
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}${TEAMS_RUN_STATUS_PATH}`)
    expect(JSON.parse(String(init.body))).toEqual({ teamId: "t1", sinceTs: 5 })
  })

  it("returns null when the round-trip throws", async () => {
    const thrown = jest.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    expect(
      await fetchDesktopTeamRunStatus("t1", 0, {
        endpoint,
        fetch: thrown as unknown as typeof fetch,
      })
    ).toBeNull()
  })
})
