import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import {
  WF_APPROVE_PREFIX,
  WF_CANCEL_PREFIX,
  buildApprovalSurface,
  buildFinalSurface,
  buildProgressSegment,
  buildWorkflowRunDeepLink,
} from "./workflow-to-a2ui"

describe("buildApprovalSurface", () => {
  it("emits Card root with summary + actions when summary is non-empty", () => {
    const surface = buildApprovalSurface({
      bindingId: "abc123",
      workflowName: "Daily Standup",
      summary: "Runs every morning at 09:00",
    })
    expect(surface.rootId).toBe("root")
    const root = surface.components.root as { component: string; title: string; children: string[] }
    expect(root.component).toBe("Card")
    expect(root.title).toBe("Daily Standup")
    expect(root.children).toEqual(["summary", "actions"])

    const summary = surface.components.summary as { component: string; text: string }
    expect(summary.text).toBe("Runs every morning at 09:00")

    const approve = surface.components.approve as { value: string; action: string }
    expect(approve.value).toBe(`${WF_APPROVE_PREFIX}abc123`)
    expect(approve.action).toBe("approve")

    const cancel = surface.components.cancel as { value: string; action: string }
    expect(cancel.value).toBe(`${WF_CANCEL_PREFIX}abc123`)
  })

  it("omits the summary child when no summary is provided", () => {
    const surface = buildApprovalSurface({ bindingId: "x", workflowName: "X" })
    const root = surface.components.root as { children: string[] }
    expect(root.children).toEqual(["actions"])
    expect(surface.components.summary).toBeUndefined()
  })

  it("provides a numeric-fallback mirror text for plaintext platforms", () => {
    const surface = buildApprovalSurface({
      bindingId: "id",
      workflowName: "X",
      summary: "summary",
    })
    const widget = surface.widget as { fallbackText: string }
    expect(widget.fallbackText).toContain("# X")
    expect(widget.fallbackText).toContain("summary")
    expect(widget.fallbackText).toContain("[Approve] [Cancel]")
    expect(widget.fallbackText).toContain("回复 1 同意 / 2 取消")
  })

  it("uses distinct prefixes for approve vs cancel so bus can route by kind", () => {
    const surface = buildApprovalSurface({ bindingId: "uuid", workflowName: "Y" })
    const approve = surface.components.approve as { value: string }
    const cancel = surface.components.cancel as { value: string }
    expect(approve.value.startsWith(WF_APPROVE_PREFIX)).toBe(true)
    expect(cancel.value.startsWith(WF_CANCEL_PREFIX)).toBe(true)
    expect(approve.value).not.toBe(cancel.value)
  })
})

describe("buildProgressSegment", () => {
  function makeEvent(partial: Partial<WorkflowRunEventRow>): WorkflowRunEventRow {
    return {
      id: "ev1",
      runId: "r1",
      ts: 1_000_000,
      type: "step_started",
      ...partial,
    }
  }

  it("renders step_started as ▶ with label", () => {
    const seg = buildProgressSegment(makeEvent({ type: "step_started", stepId: "node_search" }), {
      label: "Search",
    })
    expect(seg).toEqual({ type: "markdown", md: "▶ Step «Search» 开始" })
  })

  it("renders step_completed with duration when start time is provided", () => {
    const seg = buildProgressSegment(
      makeEvent({ type: "step_completed", stepId: "n1", ts: 1_001_200 }),
      { label: "Search", previousStepStartedAt: 1_000_000 }
    )
    expect(seg).toEqual({ type: "markdown", md: "✓ Step «Search» 完成 (1.2s)" })
  })

  it("renders step_completed without duration when no start time is provided", () => {
    const seg = buildProgressSegment(makeEvent({ type: "step_completed", stepId: "n1" }), {
      label: "Search",
    })
    expect(seg).toEqual({ type: "markdown", md: "✓ Step «Search» 完成" })
  })

  it("renders step_failed with truncated message", () => {
    const seg = buildProgressSegment(
      makeEvent({
        type: "step_failed",
        stepId: "n2",
        payload: { message: "boom" },
      }),
      { label: "Compile" }
    )
    expect(seg).toEqual({ type: "markdown", md: "✗ Step «Compile» 失败：boom" })
  })

  it("renders step_failed without message when payload omits one", () => {
    const seg = buildProgressSegment(makeEvent({ type: "step_failed", stepId: "n2" }), {
      label: "Compile",
    })
    expect(seg).toEqual({ type: "markdown", md: "✗ Step «Compile» 失败" })
  })

  it("renders step_skipped as ⊘", () => {
    const seg = buildProgressSegment(makeEvent({ type: "step_skipped", stepId: "n3" }), {
      label: "Notify",
    })
    expect(seg).toEqual({ type: "markdown", md: "⊘ Step «Notify» 跳过" })
  })

  it("returns null for non-step-scoped events", () => {
    expect(buildProgressSegment(makeEvent({ type: "run_started", stepId: undefined }))).toBeNull()
    expect(buildProgressSegment(makeEvent({ type: "run_completed", stepId: undefined }))).toBeNull()
  })

  it("falls back to stepId when no label is provided", () => {
    const seg = buildProgressSegment(makeEvent({ type: "step_started", stepId: "raw_id" }))
    expect(seg).toEqual({ type: "markdown", md: "▶ Step «raw_id» 开始" })
  })
})

describe("buildFinalSurface", () => {
  function makeRun(partial: Partial<WorkflowRunRow>): WorkflowRunRow {
    return {
      id: "r1",
      workflowId: "wf",
      status: "succeeded",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 1_000_000,
      completedAt: 1_002_500,
      workflowSnapshot: {} as never,
      ...partial,
    }
  }

  it("renders succeeded with truncated output", () => {
    const surface = buildFinalSurface({
      run: makeRun({ output: { foo: "bar" } }),
    })
    const root = surface.components.root as { title: string; children: string[] }
    expect(root.title).toBe("✓ Succeeded (2.5s)")
    expect(root.children).toEqual(["body", "openLink"])
    const body = surface.components.body as { text: string }
    expect(body.text).toContain("foo")
    expect(body.text).toContain("bar")
  })

  it("uses outputOverride when provided", () => {
    const surface = buildFinalSurface({
      run: makeRun({ output: { ignored: true } }),
      outputOverride: "custom summary",
    })
    const body = surface.components.body as { text: string }
    expect(body.text).toBe("custom summary")
  })

  it("renders failed with error message", () => {
    const surface = buildFinalSurface({
      run: makeRun({ status: "failed", error: { message: "boom" } }),
    })
    const root = surface.components.root as { title: string }
    expect(root.title).toBe("✗ Failed (2.5s)")
    const body = surface.components.body as { text: string }
    expect(body.text).toBe("boom")
  })

  it("renders cancelled without body but always exposes the deep-link", () => {
    const surface = buildFinalSurface({ run: makeRun({ status: "cancelled", output: undefined }) })
    const root = surface.components.root as { title: string; children: string[] }
    expect(root.title).toBe("⊘ Cancelled (2.5s)")
    expect(root.children).toEqual(["openLink"])
    expect(surface.components.body).toBeUndefined()
    const link = surface.components.openLink as { component: string; href: string }
    expect(link.component).toBe("Link")
    expect(link.href).toBe("cognia://workflow-run/wf/r1")
  })

  it("truncates very long output to OUTPUT_SUMMARY_MAX", () => {
    const long = "x".repeat(2000)
    const surface = buildFinalSurface({
      run: makeRun({ output: long }),
    })
    const body = surface.components.body as { text: string }
    expect(body.text.length).toBeLessThanOrEqual(500)
    expect(body.text.endsWith("…")).toBe(true)
  })

  it("formats duration in ms / s / m as appropriate", () => {
    const sub = buildFinalSurface({
      run: makeRun({ startedAt: 1_000_000, completedAt: 1_000_500 }),
    })
    expect((sub.components.root as { title: string }).title).toContain("(500ms)")
    const min = buildFinalSurface({
      run: makeRun({ startedAt: 0, completedAt: 125_000 }),
    })
    expect((min.components.root as { title: string }).title).toContain("(2m5s)")
  })

  it("provides a fallback mirror text matching the structured content", () => {
    const surface = buildFinalSurface({
      run: makeRun({ status: "succeeded", output: "done" }),
    })
    const widget = surface.widget as { fallbackText: string }
    expect(widget.fallbackText).toContain("# ✓ Succeeded")
    expect(widget.fallbackText).toContain("done")
    expect(widget.fallbackText).toContain("cognia://workflow-run/wf/r1")
  })
})

describe("buildWorkflowRunDeepLink", () => {
  it("URL-encodes both ids so embedded slashes can't break the parser", () => {
    const run = {
      id: "run/with/slash",
      workflowId: "wf:special",
    } as never
    expect(buildWorkflowRunDeepLink(run)).toBe(
      "cognia://workflow-run/wf%3Aspecial/run%2Fwith%2Fslash"
    )
  })
})
