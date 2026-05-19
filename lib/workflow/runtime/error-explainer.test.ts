import { explainLastRun, explainValidation } from "./error-explainer"
import type { NodeValidationResult } from "@/lib/workflow/nodes/validate-params"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"

const NODES = [
  { id: "n1", label: "Cron", kind: "trigger.cron" },
  { id: "n2", label: "HTTP", kind: "action.http" },
  { id: "n3", label: "Send", kind: "action.character.send" },
]

function v(fields: Record<string, { key: string }>, summary: string[] = []): NodeValidationResult {
  return { fields, summary, hasErrors: Object.keys(fields).length > 0 }
}

describe("explainValidation", () => {
  it("returns [] when all entries are clean", () => {
    expect(explainValidation({}, NODES)).toEqual([])
    expect(explainValidation({ n1: v({}) }, NODES)).toEqual([])
  })

  it("produces one issue per failing node with severity=error and blocking=true", () => {
    const issues = explainValidation(
      {
        n1: v({ cron: { key: "cronExpr" } }, ["Invalid cron expression"]),
        n2: v({ url: { key: "required" } }, []),
      },
      NODES
    )
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({
      nodeId: "n1",
      nodeLabel: "Cron",
      nodeKind: "trigger.cron",
      severity: "error",
      blocking: true,
      jumpToNodeId: "n1",
      fields: ["cron"],
    })
    expect(issues[0].message).toContain("cron")
    expect(issues[0].suggestion).toContain("cron")
  })

  it("suggests calling wf_list_* when an id-shaped field fails", () => {
    const issues = explainValidation({ n3: v({ characterId: { key: "required" } }) }, NODES)
    expect(issues[0].suggestion).toMatch(/wf_list_/)
  })

  it("falls back to nodeId when the node is no longer on the canvas", () => {
    const issues = explainValidation({ ghost: v({ url: { key: "required" } }) }, NODES)
    expect(issues[0]).toMatchObject({
      nodeId: "ghost",
      nodeLabel: "ghost",
      nodeKind: "unknown",
    })
  })
})

describe("explainLastRun", () => {
  const ok = (finishedAt: number): LastRunSummary => ({
    status: "succeeded",
    startedAt: 0,
    finishedAt,
    durationMs: finishedAt,
    attempt: 1,
  })
  const fail = (finishedAt: number, errorMessage: string): LastRunSummary => ({
    status: "failed",
    startedAt: 0,
    finishedAt,
    durationMs: finishedAt,
    attempt: 1,
    errorMessage,
  })
  const skip = (finishedAt: number): LastRunSummary => ({
    status: "skipped",
    startedAt: 0,
    finishedAt,
    durationMs: 0,
    attempt: 1,
  })

  it("reports 'no-run' when nothing is recorded", () => {
    const report = explainLastRun({}, NODES)
    expect(report.status).toBe("no-run")
    expect(report.counts).toEqual({ succeeded: 0, failed: 0, skipped: 0 })
  })

  it("reports 'succeeded' with counts when nothing failed", () => {
    const report = explainLastRun({ n1: ok(10), n2: ok(20) }, NODES)
    expect(report.status).toBe("succeeded")
    expect(report.counts.succeeded).toBe(2)
    expect(report.failedStepId).toBeUndefined()
  })

  it("reports 'partial' when some steps succeeded and one failed", () => {
    const report = explainLastRun({ n1: ok(10), n2: fail(20, "timeout exceeded") }, NODES)
    expect(report.status).toBe("partial")
    expect(report.failedStepId).toBe("n2")
    expect(report.failedStepLabel).toBe("HTTP")
    expect(report.errorSummary).toBe("timeout exceeded")
    expect(report.suggestion).toMatch(/timeout/i)
  })

  it("reports 'failed' when no steps succeeded", () => {
    const report = explainLastRun({ n1: fail(10, "401 Unauthorized") }, NODES)
    expect(report.status).toBe("failed")
    expect(report.suggestion).toMatch(/credentials/i)
  })

  it("picks the most-recently-failed step when multiple failed", () => {
    const report = explainLastRun(
      { n1: fail(5, "older"), n2: fail(15, "newer 404 not found") },
      NODES
    )
    expect(report.failedStepId).toBe("n2")
    expect(report.errorSummary).toBe("newer 404 not found")
  })

  it("ignores skipped-only graphs and reports counts", () => {
    const report = explainLastRun({ n1: skip(10) }, NODES)
    expect(report.status).toBe("no-run")
    expect(report.counts.skipped).toBe(1)
  })
})
