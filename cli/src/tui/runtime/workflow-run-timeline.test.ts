import { buildRunTimeline } from "./workflow-run-timeline"
import type { RunStepView } from "./workflow-run-fold"

const wf = { name: "Sync" }
const steps: RunStepView[] = [
  { id: "a", label: "Start", status: "succeeded", durationMs: 2 },
  { id: "b", label: "Fetch", status: "succeeded", durationMs: 412 },
  { id: "c", label: "Generate", status: "failed", durationMs: 30, error: "rate limited" },
  { id: "d", label: "Notify", status: "skipped" },
]

describe("buildRunTimeline", () => {
  it("renders a header, per-step lines with glyphs+durations, and the failure reason", () => {
    const md = buildRunTimeline(wf, steps, "failed")
    expect(md).toContain("# Workflow run · Sync — failed")
    expect(md).toContain("✓ Start · 2ms")
    expect(md).toContain("✓ Fetch · 412ms")
    expect(md).toContain("✗ Generate · 30ms — rate limited")
    expect(md).toContain("⊘ Notify")
    expect(md).toContain("4 steps · 2 ok · 1 failed · 1 skipped")
  })

  it("omits the duration when a step never started", () => {
    const md = buildRunTimeline(wf, [{ id: "a", label: "Pending", status: "pending" }], "succeeded")
    expect(md).toContain("· Pending")
    expect(md).not.toContain("Pending ·")
  })

  it("handles an empty step list", () => {
    expect(buildRunTimeline(wf, [], "succeeded")).toContain("_No steps recorded._")
  })
})
