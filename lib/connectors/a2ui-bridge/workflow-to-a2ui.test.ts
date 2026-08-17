import { WF_APPROVE_PREFIX, WF_CANCEL_PREFIX, buildApprovalSurface } from "./workflow-to-a2ui"

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
