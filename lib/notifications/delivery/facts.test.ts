// Coverage for fact derivation (V2): which run events are notification-worthy
// and what fact they materialize as — stable logicalKey, category/purpose/
// level mapping, interrupt-per-id keying, and the null result for events that
// carry no operator-facing signal. Also `renderFactForTarget` — the bridge
// into the disclosure clipper. Pure — no Dexie.

import { deriveFactFromRunEvent, renderFactForTarget, runFactLogicalKey } from "./facts"
import type { ExecutionRun, RunEvent } from "@/types/execution/run"

function run(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: over.id ?? "r1",
    kind: over.kind ?? "workflow",
    sourceId: "src",
    title: over.title ?? "Deploy run",
    status: over.status ?? "running",
    currentRevision: 1,
    startedAt: 0,
    updatedAt: 0,
    ...(over.projectId ? { projectId: over.projectId } : {}),
  }
}

function event(type: RunEvent["type"], over: Partial<RunEvent> = {}): RunEvent {
  return {
    id: over.id ?? `e_${type}`,
    runId: "r1",
    seq: over.seq ?? 1,
    ts: 0,
    type,
    visibility: "summary",
    payload: over.payload ?? {},
    ...(over.projectId ? { projectId: over.projectId } : {}),
  }
}

describe("deriveFactFromRunEvent", () => {
  it("maps a terminal completed event to a run.terminal fact", () => {
    const d = deriveFactFromRunEvent(
      run(),
      event("run.completed", { payload: { title: "Deploy done" } })
    )
    expect(d).not.toBeNull()
    expect(d!.fact.category).toBe("run.terminal")
    expect(d!.fact.purpose).toBe("terminal-state")
    expect(d!.fact.level).toBe("info")
    expect(d!.fact.runId).toBe("r1")
    expect(d!.title).toBe("Deploy done")
  })

  it("maps run.failed to an error-level terminal fact", () => {
    const d = deriveFactFromRunEvent(run(), event("run.failed"))
    expect(d!.fact.level).toBe("error")
    expect(d!.title).toContain("Run failed")
  })

  it("maps interrupt.requested to an approval-request fact keyed by interrupt id", () => {
    const d = deriveFactFromRunEvent(
      run(),
      event("interrupt.requested", { payload: { interruptId: "int-9" } })
    )
    expect(d!.fact.category).toBe("approval.request")
    expect(d!.fact.purpose).toBe("approval-request")
    // Per-interrupt key — two requests are distinct facts.
    expect(d!.fact.factKey).toContain("int-9")
  })

  it("produces a stable logicalKey for a lifecycle event", () => {
    const d = deriveFactFromRunEvent(run(), event("run.completed"))
    expect(d!.fact.factKey).toBe(runFactLogicalKey("r1", "terminal"))
    // Re-deriving the same event names the SAME fact (dedupe/supersede hold).
    expect(deriveFactFromRunEvent(run(), event("run.completed"))!.fact.factKey).toBe(
      d!.fact.factKey
    )
  })

  it("maps step.failed to an incident fact", () => {
    const d = deriveFactFromRunEvent(run(), event("step.failed"))
    expect(d!.fact.category).toBe("incident")
    expect(d!.fact.purpose).toBe("incident-alert")
  })

  it("maps run.recovery_required to a run.interrupt incident", () => {
    const d = deriveFactFromRunEvent(run(), event("run.recovery_required"))
    expect(d!.fact.category).toBe("run.interrupt")
    expect(d!.fact.level).toBe("warning")
  })

  it("maps run.waiting to a live-progress waiting fact", () => {
    const d = deriveFactFromRunEvent(run(), event("run.waiting"))
    expect(d!.fact.category).toBe("run.waiting")
    expect(d!.fact.purpose).toBe("live-progress")
  })

  it("returns null for a non-notifiable event (tool.started)", () => {
    expect(deriveFactFromRunEvent(run(), event("tool.started" as RunEvent["type"]))).toBeNull()
  })

  it("returns null for a detail-only event (resource.changed)", () => {
    expect(deriveFactFromRunEvent(run(), event("resource.changed" as RunEvent["type"]))).toBeNull()
  })

  it("falls back to a generic title when the payload has none", () => {
    const d = deriveFactFromRunEvent(run({ title: "My run" }), event("run.completed"))
    expect(d!.title).toContain("My run")
  })

  it("reads body from summary then detail", () => {
    const a = deriveFactFromRunEvent(run(), event("run.failed", { payload: { summary: "boom" } }))
    expect(a!.body).toBe("boom")
    const b = deriveFactFromRunEvent(run(), event("run.failed", { payload: { detail: "deep" } }))
    expect(b!.body).toBe("deep")
  })
})

describe("renderFactForTarget", () => {
  it("renders the fact's body as an evidence line for an internal target", () => {
    const derived = deriveFactFromRunEvent(
      run(),
      event("run.failed", { payload: { title: "F", summary: "boom" } })
    )!
    const p = renderFactForTarget({ derived, profileId: "internal" })
    expect(p.title).toBe("F")
    expect(p.body).toContain("boom")
    expect(p.level).toBe("error")
    expect(p.disclosureLevel).toBe("internal")
    expect(p.contentHash).toBeTruthy()
  })

  it("clips to a public target's ceiling + privacy title", () => {
    const derived = deriveFactFromRunEvent(
      run(),
      event("run.failed", { payload: { title: "Secret run", summary: "classified" } })
    )!
    const p = renderFactForTarget({ derived, profileId: "public" })
    expect(p.title).toBe("A run notification") // privacy mode
    expect(p.body).not.toContain("classified") // confidential clipped
  })

  it("renders an empty body when the fact has no body text", () => {
    const derived = deriveFactFromRunEvent(
      run(),
      event("run.started", { payload: { title: "S" } })
    )!
    const p = renderFactForTarget({ derived, profileId: "internal" })
    expect(p.title).toBe("S")
    expect(p.body).toBe("")
  })
})
