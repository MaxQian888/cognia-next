import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { PlanApprovalOverlay } from "./PlanApprovalOverlay"

// jsdom has no Yoga, so stub the position reader for the click test.
jest.mock("../../input/element-position", () => ({
  absoluteTopLeft: () => ({ top: 0, left: 0 }),
}))

describe("PlanApprovalOverlay", () => {
  beforeEach(() => __resetInk())

  it("shows every choice in the Claude-Code idiom and a scroll/edit footer hint", () => {
    const { container } = render(
      <PlanApprovalOverlay index={0} onMove={() => {}} onSelect={() => {}} onCancel={() => {}} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Ready to code?")
    expect(text).toContain("Yes, and auto-accept edits")
    expect(text).toContain("Yes, but confirm each edit")
    expect(text).toContain("Yes, in a fresh session")
    expect(text).toContain("Edit plan first")
    expect(text).toContain("No, keep planning")
    expect(text).toContain("PgUp/PgDn scroll plan")
    expect(text).toContain("Ctrl+G edit")
  })

  it("shows the plan title when a plan body is provided", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={"# Add retry to the fetch client\n\n- a\n- b"}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("Add retry to the fetch client")
  })

  it("triggers the edit-plan decision on Ctrl+G", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={0} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
    )
    __fireInput("g", { ctrl: true })
    expect(onSelect).toHaveBeenCalledWith("edit-then-approve")
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

  it("selects `approve-new-session` on Enter at index 2", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={2} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
    )
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("approve-new-session")
  })

  it("selects `keep` on Enter at index 4", () => {
    const onSelect = jest.fn()
    render(
      <PlanApprovalOverlay index={4} onMove={() => {}} onSelect={onSelect} onCancel={() => {}} />
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

  // The bug this fixes: the plan body must scroll while a choice is highlighted.
  const longPlan =
    "# Big plan\n\n" + Array.from({ length: 60 }, (_, i) => `- line ${i + 1}`).join("\n")

  it("renders the plan body scrollably and scrolls to the bottom on G", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={longPlan}
        viewportRows={6}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    // Only the top of the plan is visible initially.
    expect(container.textContent ?? "").toContain("line 1")
    expect(container.textContent ?? "").not.toContain("line 60")
    // g/G jump to top/bottom without touching the selection.
    act(() => __fireInput("G"))
    expect(container.textContent ?? "").toContain("line 60")
    act(() => __fireInput("g"))
    expect(container.textContent ?? "").toContain("line 1")
  })

  it("pages the plan body with PgDn while a choice is highlighted (scroll ≠ select)", () => {
    const onSelect = jest.fn()
    const onMove = jest.fn()
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={longPlan}
        viewportRows={6}
        onMove={onMove}
        onSelect={onSelect}
        onCancel={() => {}}
      />
    )
    // Before paging, the viewport starts at the top.
    expect(container.textContent ?? "").toContain("1–6 / 61")
    act(() => __fireInput("", { pageDown: true }))
    // Scrolled one page down; the menu selection was NOT affected.
    expect(container.textContent ?? "").toContain("7–12 / 61")
    expect(container.textContent ?? "").not.toContain("1–6 / 61")
    expect(onMove).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    // Arrows still drive the selection, not the scroll.
    __fireInput("", { downArrow: true })
    expect(onMove).toHaveBeenCalledWith(1)
  })

  it("scrolls the plan body with the mouse wheel instead of moving the selection", () => {
    const onMove = jest.fn()
    const onSelect = jest.fn()
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={longPlan}
        viewportRows={6}
        onMove={onMove}
        onSelect={onSelect}
        onCancel={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("1–6 / 61")
    // Wheel down scrolls the plan (by WHEEL_STEP=3), not the choice list.
    act(() => __fireInput("[<65;1;1M", {}))
    expect(container.textContent ?? "").toContain("4–9 / 61")
    expect(onMove).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    // Wheel up scrolls back toward the top.
    act(() => __fireInput("[<64;1;1M", {}))
    expect(container.textContent ?? "").toContain("1–6 / 61")
    expect(onMove).not.toHaveBeenCalled()
  })

  it("shows a position label for the scrollable plan body", () => {
    const { container } = render(
      <PlanApprovalOverlay
        index={0}
        raw={longPlan}
        viewportRows={6}
        onMove={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    expect(container.textContent ?? "").toContain("g/G top/bottom")
  })
})
