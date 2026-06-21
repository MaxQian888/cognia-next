import React from "react"
import { render, act } from "@testing-library/react"
import { __fireInput as fireRaw, __resetInk } from "ink"

/** Drive a key through the registered `useInput` handler, flushing the
 * resulting state update before the next fire so multi-step sequences see
 * committed state (RTL requires updates to settle inside `act`). */
const __fireInput = (input: string, key: Record<string, boolean> = {}) =>
  act(() => fireRaw(input, key))

import {
  AskUserDialog,
  askUserRowCount,
  isTextRow,
  canSubmitAsk,
  toggleOption,
  moveCursor,
  buildAnswer,
  type AskUserDraft,
} from "./AskUserDialog"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"

const choice = (over: Partial<AskUserRequest> = {}): AskUserRequest => ({
  question: "Pick one",
  options: [
    { value: "a", label: "Apple" },
    { value: "b", label: "Banana" },
  ],
  multiSelect: false,
  allowText: false,
  ...over,
})

const draft = (over: Partial<AskUserDraft> = {}): AskUserDraft => ({
  selected: [],
  text: "",
  cursor: 0,
  ...over,
})

describe("AskUserDialog pure helpers", () => {
  it("counts rows including the free-text row only when allowed", () => {
    expect(askUserRowCount(choice())).toBe(2)
    expect(askUserRowCount(choice({ allowText: true }))).toBe(3)
    expect(askUserRowCount(choice({ options: [], allowText: true }))).toBe(1)
  })

  it("identifies the free-text row as the one after the options", () => {
    const req = choice({ allowText: true })
    expect(isTextRow(req, 1)).toBe(false)
    expect(isTextRow(req, 2)).toBe(true)
    expect(isTextRow(choice(), 2)).toBe(false) // allowText off → no text row
  })

  it("gates submission on a selection or non-blank text", () => {
    expect(canSubmitAsk(choice(), draft())).toBe(false)
    expect(canSubmitAsk(choice(), draft({ selected: ["a"] }))).toBe(true)
    expect(canSubmitAsk(choice({ allowText: true }), draft({ text: "  " }))).toBe(false)
    expect(canSubmitAsk(choice({ allowText: true }), draft({ text: "hi" }))).toBe(true)
  })

  it("toggles single-select as replace-or-clear and multi-select as membership", () => {
    const single = choice()
    expect(toggleOption(single, draft(), "a").selected).toEqual(["a"])
    expect(toggleOption(single, draft({ selected: ["a"] }), "b").selected).toEqual(["b"])
    expect(toggleOption(single, draft({ selected: ["a"] }), "a").selected).toEqual([])

    const multi = choice({ multiSelect: true })
    expect(toggleOption(multi, draft({ selected: ["a"] }), "b").selected).toEqual(["a", "b"])
    expect(toggleOption(multi, draft({ selected: ["a", "b"] }), "a").selected).toEqual(["b"])
  })

  it("clamps the cursor within the row range", () => {
    const req = choice({ allowText: true }) // 3 rows
    expect(moveCursor(req, draft({ cursor: 0 }), -1).cursor).toBe(0)
    expect(moveCursor(req, draft({ cursor: 2 }), 1).cursor).toBe(2)
    expect(moveCursor(req, draft({ cursor: 0 }), 1).cursor).toBe(1)
    // A single-row prompt has nothing to move to.
    expect(moveCursor(choice({ options: [], allowText: true }), draft(), 1).cursor).toBe(0)
  })

  it("builds a non-cancelled answer from the draft", () => {
    expect(buildAnswer(draft({ selected: ["a"], text: "x" }))).toEqual({
      selected: ["a"],
      text: "x",
      cancelled: false,
    })
  })
})

describe("AskUserDialog component", () => {
  beforeEach(() => __resetInk())

  it("renders the question and options", () => {
    const { container } = render(<AskUserDialog request={choice()} onResolve={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Pick one")
    expect(text).toContain("Apple")
    expect(text).toContain("Banana")
  })

  it("single-select Enter on the focused option resolves with that value", () => {
    const onResolve = jest.fn()
    render(<AskUserDialog request={choice()} onResolve={onResolve} />)
    __fireInput("", { downArrow: true }) // focus Banana
    __fireInput("", { return: true })
    expect(onResolve).toHaveBeenCalledWith({ selected: ["b"], text: "", cancelled: false })
  })

  it("multi-select Space toggles and Enter submits all", () => {
    const onResolve = jest.fn()
    render(<AskUserDialog request={choice({ multiSelect: true })} onResolve={onResolve} />)
    __fireInput(" ") // check Apple
    __fireInput("", { downArrow: true })
    __fireInput(" ") // check Banana
    __fireInput("", { return: true })
    expect(onResolve).toHaveBeenCalledWith({ selected: ["a", "b"], text: "", cancelled: false })
  })

  it("captures free text on the text row and submits it", () => {
    const onResolve = jest.fn()
    render(
      <AskUserDialog request={choice({ options: [], allowText: true })} onResolve={onResolve} />
    )
    __fireInput("h")
    __fireInput("i")
    __fireInput("", { backspace: true })
    __fireInput("y")
    __fireInput("", { return: true })
    expect(onResolve).toHaveBeenCalledWith({ selected: [], text: "hy", cancelled: false })
  })

  it("does not submit an empty answer on Enter", () => {
    const onResolve = jest.fn()
    render(
      <AskUserDialog request={choice({ options: [], allowText: true })} onResolve={onResolve} />
    )
    __fireInput("", { return: true })
    expect(onResolve).not.toHaveBeenCalled()
  })

  it("Esc cancels with a dismissed answer", () => {
    const onResolve = jest.fn()
    render(<AskUserDialog request={choice()} onResolve={onResolve} />)
    __fireInput("", { escape: true })
    expect(onResolve).toHaveBeenCalledWith({ selected: [], text: "", cancelled: true })
  })

  it("ignores mouse sequences in the text field", () => {
    const onResolve = jest.fn()
    render(
      <AskUserDialog request={choice({ options: [], allowText: true })} onResolve={onResolve} />
    )
    __fireInput("\x1b[<0;1;1M") // SGR mouse report
    __fireInput("", { return: true })
    expect(onResolve).not.toHaveBeenCalled() // text stayed empty
  })
})
