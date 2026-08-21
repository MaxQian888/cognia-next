// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage; the literals below pin the adapter
// contract every issue-run engine implements.
import "./types"
import type {
  IssueRunAdapter,
  IssueRunOrigin,
  IssueRunPollResult,
  IssueRunRefusalReason,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"

describe("IssueRunVerdict", () => {
  it("carries a keyed reason on refusal so the Run button never string-matches", () => {
    const ok: IssueRunVerdict = { ok: true }
    const no: IssueRunVerdict = { ok: false, reason: "team-busy" }
    expect(ok.ok).toBe(true)
    // The success arm has no `reason` to read — the discriminant is the gate.
    expect(no.ok === false && no.reason).toBe("team-busy")
  })

  it("allows a free-text detail alongside the keyed reason, never instead of it", () => {
    const no: IssueRunVerdict = {
      ok: false,
      reason: "assignee-not-found",
      detail: "character chr_1 was deleted",
    }
    expect(no.ok === false && no.detail).toContain("chr_1")
  })

  it("enumerates every refusal the three adapters can raise", () => {
    const reasons: IssueRunRefusalReason[] = [
      "assignee-kind-mismatch",
      "assignee-not-found",
      "team-busy",
      "no-github-ref",
      "no-github-repo",
      "desktop-only",
      "no-github-account",
      "run-active",
      "issue-finished",
      "adapter-missing",
    ]
    expect(new Set(reasons).size).toBe(10)
  })
})

describe("IssueRunTarget", () => {
  it("makes the delivery container explicitly nullable — it may have been deleted", () => {
    const issue = {} as IssueRunTarget["issue"]
    const target: IssueRunTarget = { issue, project: undefined }
    expect("project" in target).toBe(true)
    expect(target.project).toBeUndefined()
  })
})

describe("IssueRunOrigin", () => {
  it("distinguishes the interactive gesture from the IM one — they gate differently", () => {
    const origins: IssueRunOrigin[] = ["interactive", "im"]
    expect(new Set(origins).size).toBe(2)
  })
})

describe("IssueRunPollResult", () => {
  it("spells 'still working' as null rather than an absent settlement", () => {
    const stillRunning: IssueRunPollResult = null
    expect(stillRunning).toBeNull()
  })
})

describe("IssueRunAdapter", () => {
  it("is satisfiable by an object exposing id/kind/canRun/start/poll", () => {
    // `cancel` is optional: not every engine can be interrupted, and the bridge
    // settles the run as `cancelled` regardless.
    const adapter: IssueRunAdapter = {
      id: "agent-task",
      kind: "agent" as IssueRunAdapter["kind"],
      canRun: async () => ({ ok: false, reason: "assignee-kind-mismatch" }),
      start: async () => ({}) as Awaited<ReturnType<IssueRunAdapter["start"]>>,
      poll: async () => null,
    }
    expect(adapter.cancel).toBeUndefined()
    expect(adapter.id).toBe("agent-task")
  })

  it("refuses through canRun rather than throwing from it", async () => {
    const adapter: IssueRunAdapter = {
      id: "github-loop",
      kind: "github" as IssueRunAdapter["kind"],
      canRun: async () => ({ ok: false, reason: "no-github-ref" }),
      start: async () => ({}) as Awaited<ReturnType<IssueRunAdapter["start"]>>,
      poll: async () => null,
      cancel: async () => undefined,
    }
    const verdict = await adapter.canRun({} as IssueRunTarget)
    expect(verdict).toEqual({ ok: false, reason: "no-github-ref" })
  })
})
