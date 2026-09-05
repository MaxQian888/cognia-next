import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"
import { PlanApprovalOverlay } from "./PlanApprovalOverlay"
import { PLAN_APPROVAL_CHOICES } from "../../runtime/plan"
import { TuiInputProvider } from "../../input/input-router"

jest.mock("../../input/element-position", () => ({
  absoluteTopLeft: () => ({ top: 0, left: 0 }),
}))

const longPlan = Array.from({ length: 60 }, (_, i) => `- row-${i + 1}`).join("\n")
const defaults = { index: 0, onMove: jest.fn(), onSelect: jest.fn(), onCancel: jest.fn() }
const fire = (input = "", key = {}) => act(() => __fireInput(input, key))
function mount(props: Partial<React.ComponentProps<typeof PlanApprovalOverlay>> = {}) {
  return render(
    <TuiInputProvider>
      <PlanApprovalOverlay {...defaults} raw={longPlan} {...props} />
    </TuiInputProvider>
  )
}

describe("PlanApprovalOverlay", () => {
  beforeEach(() => {
    __resetInk()
    jest.clearAllMocks()
  })

  it("gives the plan most rows, with content before compact review controls", () => {
    const { container } = mount({ viewportRows: 22 })
    expect(container.textContent).toContain("Review plan")
    expect(container.textContent).toContain("1–19 / 60")
    expect(container.textContent).toContain("32%")
    expect(container.textContent).toContain("row-19")
    expect(container.textContent).not.toContain("row-20")
    expect(container.textContent).not.toContain("auto-accept")
    expect(container.textContent!.indexOf("row-1")).toBeLessThan(
      container.textContent!.indexOf("Enter actions")
    )
  })

  it("separates the neutral title, muted metadata and primary control", () => {
    const { getByText, container } = mount({ raw: "- one step" })
    expect(getByText("Review plan").getAttribute("data-color")).toBeNull()
    expect(getByText(/1 step · 1 line/).getAttribute("data-color")).not.toBeNull()
    expect(getByText("Enter actions").getAttribute("data-color")).not.toBeNull()
    expect(container.textContent).toContain("─")
    expect(container.textContent).toContain("Ctrl+G edit")
  })

  it.each(PLAN_APPROVAL_CHOICES.map((choice, index) => [index, choice.hint] as const))(
    "explains action %i instead of repeating the keyboard legend",
    (index, hint) => {
      const { container } = mount({ index, columns: 100 })
      fire("", { return: true })
      expect(container.textContent).toContain(hint)
      expect(container.textContent!.match(/Enter select/g)).toHaveLength(1)
      expect(container.textContent).toContain("Tab review")
      expect(defaults.onSelect).not.toHaveBeenCalled()
    }
  )

  it("prioritizes navigation over long action explanations on narrow terminals", () => {
    const { container } = mount({ columns: 40, viewportRows: 7 })
    fire("", { tab: true })
    expect(container.textContent).toContain("Enter select · ↑/↓ choose · Tab review")
    expect(container.textContent).not.toContain(PLAN_APPROVAL_CHOICES[0].hint)
  })

  it.each([0, 1, 2, 3, 4])(
    "reviews before dispatching choice %i through the unchanged API",
    (index) => {
      mount({ index })
      fire("", { return: true })
      expect(defaults.onSelect).not.toHaveBeenCalled()
      fire("", { return: true })
      expect(defaults.onSelect).toHaveBeenCalledWith(
        ["approve-auto", "approve-confirm", "approve-new-session", "edit-then-approve", "keep"][
          index
        ]
      )
    }
  )

  it("clicks only the compact action row and still requires review first", () => {
    mount({ viewportRows: 7 })
    fire("[<0;3;2M")
    expect(defaults.onSelect).not.toHaveBeenCalled()
    fire("[<0;3;7M")
    expect(defaults.onSelect).not.toHaveBeenCalled()
    fire("[<0;3;7M")
    expect(defaults.onSelect).toHaveBeenCalledWith("approve-auto")
  })

  it("arrows scroll during review and move selection only in the action phase", () => {
    const { container } = mount({ viewportRows: 7 })
    fire("", { downArrow: true })
    expect(container.textContent).toContain("2–5 / 60")
    expect(defaults.onMove).not.toHaveBeenCalled()
    fire("", { upArrow: true })
    expect(container.textContent).toContain("1–4 / 60")
    fire("", { tab: true })
    fire("", { downArrow: true })
    fire("", { upArrow: true })
    expect(defaults.onMove.mock.calls).toEqual([[1], [-1]])
    fire("", { tab: true })
    fire("", { return: true })
    expect(defaults.onSelect).not.toHaveBeenCalled()
  })

  it("wheel, pages, Space/b and g/G scroll physical rows without selecting", () => {
    const { container } = mount({ viewportRows: 7 })
    fire("[<65;1;1M")
    expect(container.textContent).toContain("4–7 / 60")
    fire("[<64;1;1M")
    expect(container.textContent).toContain("1–4 / 60")
    fire("", { pageDown: true })
    expect(container.textContent).toContain("5–8 / 60")
    fire("", { pageUp: true })
    fire(" ")
    expect(container.textContent).toContain("5–8 / 60")
    fire("b")
    fire("G")
    expect(container.textContent).toContain("57–60 / 60")
    expect(container.textContent).toContain("100%")
    fire("g")
    expect(container.textContent).toContain("1–4 / 60")
    fire("x")
    expect(defaults.onMove).not.toHaveBeenCalled()
    expect(defaults.onSelect).not.toHaveBeenCalled()
  })

  it.each([false, true])("keeps Ctrl+G and Escape callable with actions=%s", (actions) => {
    mount()
    if (actions) fire("", { tab: true })
    fire("G", { ctrl: true })
    expect(defaults.onSelect).toHaveBeenCalledWith("edit-then-approve")
    fire("", { escape: true })
    expect(defaults.onCancel).toHaveBeenCalledTimes(1)
  })

  it("pages inside a single long paragraph at the supplied width", () => {
    const { container } = mount({ raw: "a".repeat(400) + "TAIL", columns: 21, viewportRows: 7 })
    expect(container.textContent).not.toContain("TAIL")
    fire("G")
    expect(container.textContent).toContain("TAIL")
    expect(container.textContent).toContain("18–21 / 21")
  })

  it.each([
    "```ts\n" + "const value = 1; ".repeat(40) + "CODE_END\n```",
    "| Name | Value |\n| --- | --- |\n" +
      Array.from({ length: 30 }, (_, i) => `| item${i} | value${i} |`).join("\n"),
  ])("can reach the bottom of a code/table block", (raw) => {
    const { container } = mount({ raw, columns: 40, viewportRows: 7 })
    const initial = container.textContent
    fire("G")
    expect(container.textContent).not.toBe(initial)
    expect(container.textContent).toContain("100%")
    expect(container.textContent).toContain(raw.startsWith("```") ? "CODE_END" : "value29")
  })

  it("preserves the visible row after insertion and requires review again", () => {
    const { container, rerender } = mount({ viewportRows: 7 })
    fire("", { pageDown: true })
    fire("", { tab: true })
    rerender(
      <TuiInputProvider>
        <PlanApprovalOverlay {...defaults} raw={"- new section\n" + longPlan} viewportRows={7} />
      </TuiInputProvider>
    )
    expect(container.textContent).toContain("row-5")
    expect(container.textContent).toContain("6–9 / 61")
    fire("", { return: true })
    expect(defaults.onSelect).not.toHaveBeenCalled()
    fire("", { return: true })
    expect(defaults.onSelect).toHaveBeenCalledWith("approve-auto")
  })

  it("keeps scroll valid when a revision is shorter or the viewport grows", () => {
    const { container, rerender } = mount({ viewportRows: 7 })
    fire("G")
    rerender(<PlanApprovalOverlay {...defaults} raw="short replacement" viewportRows={20} />)
    expect(container.textContent).toContain("short replacement")
    expect(container.textContent).toContain("all · 100%")
  })

  it("reflows on resize without resetting the reader to the top", () => {
    const raw = "0123456789".repeat(50)
    const { container, rerender } = mount({ raw, viewportRows: 7, columns: 21 })
    fire("", { pageDown: true })
    rerender(
      <TuiInputProvider>
        <PlanApprovalOverlay {...defaults} raw={raw} viewportRows={7} columns={41} />
      </TuiInputProvider>
    )
    expect(container.textContent).toContain("3–6 / 13")
  })

  it.each([1, 2, 3, 7])("keeps content in a %i-row terminal", (viewportRows) => {
    const { container } = mount({ viewportRows, columns: 30 })
    expect(container.textContent).toContain("row-1")
    expect(container.textContent).not.toContain("auto-accept")
  })

  it("shows revision stats or the saved path when space permits", () => {
    const { container, rerender } = mount({
      raw: "# Plan\n- a\n- c\n- d",
      prevPlan: "# Plan\n- a\n- b",
    })
    expect(container.textContent).toContain("3 steps")
    expect(container.textContent).toContain("Revised plan · +2 −1 lines")
    rerender(<PlanApprovalOverlay {...defaults} raw="# Plan" savedTo="/tmp/plan.md" />)
    expect(container.textContent).toContain("Saved to /tmp/plan.md")
  })

  it.each([undefined, "", "   "])("does not approve missing content (%s)", (raw) => {
    const { container } = mount({ raw })
    expect(container.textContent).toContain("No plan content")
    fire("", { return: true })
    fire("", { return: true })
    expect(defaults.onSelect).not.toHaveBeenCalled()
  })

  it("still allows keeping an empty plan and clamps invalid selection", () => {
    mount({ raw: "", index: 99 })
    fire("", { return: true })
    fire("", { return: true })
    expect(defaults.onSelect).toHaveBeenCalledWith("keep")
  })
})
