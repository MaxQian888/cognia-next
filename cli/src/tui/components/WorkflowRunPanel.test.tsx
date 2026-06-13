import React from "react"
import { render } from "@testing-library/react"

import { WorkflowRunPanel } from "./WorkflowRunPanel"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"
import type { WorkflowRunState } from "../state/types"

const wrap = (run: WorkflowRunState | undefined, maxRows?: number) =>
  render(
    <ThemeProvider palette={BUILTIN_THEMES.classic}>
      <WorkflowRunPanel run={run} {...(maxRows !== undefined ? { maxRows } : {})} />
    </ThemeProvider>
  )

describe("WorkflowRunPanel", () => {
  it("renders nothing when there is no run", () => {
    const { container } = wrap(undefined)
    expect(container.textContent).toBe("")
  })

  it("renders nothing when the run has no steps", () => {
    const { container } = wrap({ steps: [], completed: 0 })
    expect(container.textContent).toBe("")
  })

  it("shows a header with completed/total and glyphs+durations for visible steps", () => {
    const run: WorkflowRunState = {
      completed: 1,
      currentId: "b",
      steps: [
        { id: "a", label: "Start", status: "succeeded", durationMs: 2 },
        { id: "b", label: "Fetch", status: "running", startedAt: 1 },
        { id: "c", label: "Gen", status: "pending" },
      ],
    }
    const text = wrap(run, 10).container.textContent ?? ""
    expect(text).toContain("Running workflow")
    expect(text).toContain("1/3")
    expect(text).toContain("✓ Start")
    expect(text).toContain("2ms")
    expect(text).toContain("⏳ Fetch")
    expect(text).toContain("running…")
    expect(text).toContain("· Gen")
  })

  it("shows the failure reason inline for a failed step", () => {
    const run: WorkflowRunState = {
      completed: 1,
      steps: [{ id: "a", label: "Gen", status: "failed", durationMs: 5, error: "rate limited" }],
    }
    const text = wrap(run, 10).container.textContent ?? ""
    expect(text).toContain("✗ Gen")
    expect(text).toContain("rate limited")
  })

  it("windows large lists centred on the running step with hidden-count hints", () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
      status:
        i < 10 ? ("succeeded" as const) : i === 10 ? ("running" as const) : ("pending" as const),
    }))
    const text = wrap({ steps, completed: 10, currentId: "n10" }, 5).container.textContent ?? ""
    expect(text).toContain("done") // ↑ N done above-hint
    expect(text).toContain("Node 10")
    expect(text).toContain("pending") // ↓ N pending below-hint
    // A far-away node is outside the window.
    expect(text).not.toContain("Node 0 ")
  })

  it("falls back to the completed index when there is no running step", () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
      status: i < 3 ? ("succeeded" as const) : ("pending" as const),
    }))
    const text = wrap({ steps, completed: 3 }, 3).container.textContent ?? ""
    expect(text).toContain("Node 3")
  })
})
