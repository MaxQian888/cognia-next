import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { PlanApprovalOverlay } from "./PlanApprovalOverlay"

// jsdom has no Yoga, so stub the position reader for the click test.
jest.mock("../../input/element-position", () => ({
  absoluteTopLeft: () => ({ top: 0, left: 0 }),
}))

describe("PlanApprovalOverlay", () => {
  beforeEach(() => __resetInk())

  it("shows the three choices, the Claude-Code framing, and a clickable footer hint", () => {
    const { container } = render(
      <PlanApprovalOverlay index={0} onMove={() => {}} onSelect={() => {}} onCancel={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Ready to code?")
    expect(text).toContain("Approve & build (auto-edits)")
    expect(text).toContain("Approve — confirm each edit")
    expect(text).toContain("Keep planning")
    expect(text).toContain("click a choice")
  })

  it("shows a step/line stat line when the plan body is provided", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={"# Plan\n- a\n- b\n- c"}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("3 steps")
  })

  it("selects the clicked choice in mouse scroll mode", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={0} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
    )
    // No title row on the SelectList → border(1) → first choice at SGR row 2;
    // row 3 → second choice (approve-confirm).
    __fireInput("[<0;3;3M", {})
    expect(onSelect).toHaveBeenCalledWith("approve-confirm")
  })

  it("shows a +A −R revision badge when this plan supersedes a previous one", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={"# Plan\n- a\n- c\n- d"}
        prevPlan={"# Plan\n- a\n- b"}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Revised plan")
    expect(text).toContain("+2") // - c, - d added
    expect(text).toContain("−1") // - b removed
  })

  it("omits the revision badge for a first plan (no previous)", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={"# Plan\n- a"}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    expect(container.textContent ?? "").not.toContain("Revised plan")
  })

  it("shows the saved path when provided", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        savedTo="/home/.cognia/plans/s-plan-1.md"
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("/home/.cognia/plans/s-plan-1.md")
  })

  it("selects `approve-auto` on Enter at index 0", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={0} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
    )
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("approve-auto")
  })

  it("selects `approve-confirm` on Enter at index 1", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={1} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
    )
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("approve-confirm")
  })

  it("selects `keep` on Enter at index 2", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={2} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
    )
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("keep")
  })

  it("cancels (keep planning) on Escape", () => {
    const onCancel = jest.fn()
    render(
      <PlanApprovalOverlay index={0} onMove={() => {}} onSelect={() => {}} onCancel={onCancel} />
    )
    __fireInput("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })

  it("moves the highlight with the arrow keys", () => {
    const onMove = jest.fn()
    render(
      <PlanApprovalOverlay index={0} onMove={onMove} onSelect={() => {}} onCancel={() => {}} />
    )
    __fireInput("", { downArrow: true })
    expect(onMove).toHaveBeenCalledWith(1)
  })
})
