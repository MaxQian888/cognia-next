/**
 * `ctx.issues`: the plugin face of the tracker. The service is mocked, so
 * what is pinned here is the gate map, the actor stamp, and how a patch
 * becomes board actions.
 */

const mockResolve = jest.fn(async (_ref: string): Promise<unknown> => undefined)
const mockCreate = jest.fn(async (req: unknown) => ({
  id: "n",
  identifier: "MERC-9",
  externalKeys: [],
  ...(req as object),
}))
const mockQuery = jest.fn(async (_q: unknown): Promise<unknown[]> => [])
const mockApply = jest.fn(async (..._a: unknown[]) => ({ applied: 1, skipped: 0, failed: 0 }))
jest.mock("@/lib/issues/service", () => {
  const actual = jest.requireActual("@/lib/issues/service")
  return {
    ...actual,
    resolveIssue: (ref: string) => mockResolve(ref),
    createIssueRecord: (req: unknown) => mockCreate(req),
    queryIssues: (q: unknown) => mockQuery(q),
    applyIssueAction: (...a: unknown[]) => mockApply(...a),
  }
})
const mockListEvents = jest.fn(async (_q: unknown) => [{ id: "e1" }])
jest.mock("@/lib/db/issue-events", () => ({ listIssueEvents: (q: unknown) => mockListEvents(q) }))
jest.mock("@/lib/issues/sync/apply", () => ({
  ensureIssueLabels: async (names: readonly string[]) =>
    names.map((name) => ({ id: `l:${name}`, name })),
}))
jest.mock("@/lib/db/labels", () => ({ listLabels: async () => [{ id: "l:bug", name: "Bug" }] }))
const mockRegister = jest.fn((_p: unknown) => () => {})
jest.mock("@/lib/issues/sync/registry", () => ({
  registerIssueSyncProvider: (p: unknown) => mockRegister(p),
}))
const guarded = jest.fn()
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  createGuardedAPI: (_id: string, api: unknown, map: Record<string, string>) => {
    guarded(map)
    return api
  },
}))

import { emitIssueEvent } from "@/lib/issues/event-bus"
import type { IssueEvent } from "@/types/issues"
import { createIssuesAPI, pluginIssueActor } from "./issues-api"

const issue = { id: "i1", identifier: "MERC-1", projectId: "w1", externalKeys: ["k"] }

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockResolvedValue(issue)
})

describe("createIssuesAPI", () => {
  it("gates every method, reads and subscriptions on issue:read, the rest on issue:write", () => {
    const api = createIssuesAPI("p")
    const map = guarded.mock.calls[0][0] as Record<string, string>
    expect(Object.keys(map).sort()).toEqual(Object.keys(api).sort())
    expect(map.get).toBe("issue:read")
    expect(map.onEvent).toBe("issue:read")
    expect(map.create).toBe("issue:write")
    expect(map.registerSyncProvider).toBe("issue:write")
  })

  it("stamps the plugin as the actor on creates and actions", async () => {
    const api = createIssuesAPI("acme")
    const created = await api.create({ title: "x" })
    expect(mockCreate).toHaveBeenCalledWith({ title: "x", by: pluginIssueActor("acme") })
    expect("externalKeys" in created).toBe(false)
    await api.comment("MERC-1", " hi ")
    expect(mockApply).toHaveBeenCalledWith(
      issue,
      { kind: "comment", body: "hi" },
      pluginIssueActor("acme")
    )
  })

  it("turns a patch into ordered board actions and sums the outcomes", async () => {
    const api = createIssuesAPI("p")
    mockApply.mockResolvedValueOnce({ applied: 1, skipped: 0, failed: 0 })
    mockApply.mockResolvedValueOnce({ applied: 0, skipped: 1, failed: 0, reason: "running" })
    const out = await api.update("MERC-1", { status: "done", cycleId: null })
    expect(mockApply.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual([
      "status",
      "cycle",
    ])
    expect(out).toEqual({ applied: 1, skipped: 1, failed: 0, reason: "running" })
    await expect(api.update("MERC-1", {})).rejects.toThrow(/Nothing/)
    await expect(api.update("MERC-1", { status: "closed" })).rejects.toThrow(/status/)
  })

  it("returns null for an unknown ref on get, and throws on writes", async () => {
    const api = createIssuesAPI("p")
    mockResolve.mockResolvedValue(undefined)
    expect(await api.get("MERC-404")).toBeNull()
    await expect(api.assign("MERC-404", null)).rejects.toThrow(/No issue/)
  })

  it("labels by name, reads the trail newest first, and registers a sync provider", async () => {
    const api = createIssuesAPI("p")
    await api.label("MERC-1", { add: ["Docs"], remove: ["bug"] })
    expect(mockApply.mock.calls.map((c) => c[1])).toEqual([
      { kind: "addLabel", labelId: "l:Docs" },
      { kind: "removeLabel", labelId: "l:bug" },
    ])
    await api.listEvents("MERC-1", 5)
    expect(mockListEvents).toHaveBeenCalledWith({ issueId: "i1", descending: true, limit: 5 })
    const provider = { id: "acme-tracker" }
    api.registerSyncProvider(provider as never)
    expect(mockRegister).toHaveBeenCalledWith(provider)
    expect(() => api.registerSyncProvider({ id: " " } as never)).toThrow(/id/)
  })

  it("delivers bus events to a subscriber until disposed", () => {
    const api = createIssuesAPI("p")
    const seen: string[] = []
    const off = api.onEvent((e) => seen.push(e.id), { kinds: ["commented"] })
    const event = {
      id: "e1",
      issueId: "i1",
      kind: "commented",
      ts: 1,
      payload: { kind: "commented" },
    } as unknown as IssueEvent
    emitIssueEvent(event)
    emitIssueEvent({ ...event, id: "e2", kind: "created" } as IssueEvent)
    off()
    emitIssueEvent({ ...event, id: "e3" })
    expect(seen).toEqual(["e1"])
  })
})
