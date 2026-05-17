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
})
