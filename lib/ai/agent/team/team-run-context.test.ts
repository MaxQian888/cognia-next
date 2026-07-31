import {
  registerTeamRunContext,
  getTeamRunContext,
  unregisterTeamRunContext,
  __resetTeamRunContextForTesting,
  type TeamRunContext,
} from "./team-run-context"
import type { AgentTeam } from "@/types/agent/agent-team"

const fakeCtx = (runId: string): TeamRunContext =>
  ({
    runId,
    teamId: "team-1",
    team: { id: "team-1" } as unknown as AgentTeam,
    pool: {} as TeamRunContext["pool"],
    budget: {} as TeamRunContext["budget"],
    notifier: {} as TeamRunContext["notifier"],
    concurrency: {} as TeamRunContext["concurrency"],
    modelPref: {} as TeamRunContext["modelPref"],
    storeWriter: {} as TeamRunContext["storeWriter"],
    resolvedCapabilities: new Map(),
    externalAgentInstances: new Map(),
  }) satisfies TeamRunContext

describe("TeamRunContext registry", () => {
  beforeEach(() => {
    __resetTeamRunContextForTesting()
  })

  it("register then get returns the same context", () => {
    const ctx = fakeCtx("run-1")
    registerTeamRunContext(ctx)
    expect(getTeamRunContext("run-1")).toBe(ctx)
  })

  it("get returns undefined for unknown runId", () => {
    expect(getTeamRunContext("missing")).toBeUndefined()
  })

  it("unregister drops the context", () => {
    registerTeamRunContext(fakeCtx("run-2"))
    unregisterTeamRunContext("run-2")
    expect(getTeamRunContext("run-2")).toBeUndefined()
  })

  it("re-registering same runId replaces previous entry", () => {
    const a = fakeCtx("run-3")
    const b = fakeCtx("run-3")
    registerTeamRunContext(a)
    registerTeamRunContext(b)
    expect(getTeamRunContext("run-3")).toBe(b)
  })

  it("multiple runs coexist independently", () => {
    const a = fakeCtx("run-A")
    const b = fakeCtx("run-B")
    registerTeamRunContext(a)
    registerTeamRunContext(b)
    expect(getTeamRunContext("run-A")).toBe(a)
    expect(getTeamRunContext("run-B")).toBe(b)
  })

  describe("leak guards", () => {
    let warn: jest.SpyInstance

    beforeEach(() => {
      warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    })
    afterEach(() => {
      warn.mockRestore()
    })

    it("warns when re-registering a still-live runId (un-unregistered)", () => {
      registerTeamRunContext(fakeCtx("dup"))
      registerTeamRunContext(fakeCtx("dup"))
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already registered/i))
    })

    it("does not warn on a normal register → unregister → register cycle", () => {
      registerTeamRunContext(fakeCtx("cycle"))
      unregisterTeamRunContext("cycle")
      registerTeamRunContext(fakeCtx("cycle"))
      expect(warn).not.toHaveBeenCalled()
    })

    it("warns once the registry grows past the soft limit (leak signal)", () => {
      for (let i = 0; i < 70; i++) registerTeamRunContext(fakeCtx(`run-${i}`))
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/registry size|leak/i))
    })
  })
})
