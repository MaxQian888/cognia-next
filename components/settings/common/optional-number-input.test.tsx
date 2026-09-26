/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

import { OptionalNumberInput } from "./optional-number-input"

const positiveOrUndefined = (raw: string): number | undefined => {
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function renderField(value: number | undefined, extra: Record<string, unknown> = {}) {
  const onCommit = jest.fn(async (_next: number | undefined) => undefined)
  render(
    <OptionalNumberInput
      aria-label="Daily limit"
      value={value}
      parse={positiveOrUndefined}
      onCommit={onCommit}
      {...extra}
    />
  )
  return { onCommit, input: screen.getByLabelText("Daily limit") as HTMLInputElement }
}

describe("OptionalNumberInput", () => {
  it("renders the stored value, or an empty field when unset", () => {
    const { input } = renderField(12.5)
    expect(input).toHaveValue(12.5)
    expect(input).toHaveAttribute("type", "number")
  })

  it("does not write per keystroke; writes the parsed value once, on blur", async () => {
    const { onCommit, input } = renderField(undefined)
    // "2" then "25": each keystroke used to be a save, and on a paired phone a
    // queued desktop update that set the budget to 2 on the way to 25.
    fireEvent.change(input, { target: { value: "2" } })
    fireEvent.change(input, { target: { value: "25" } })
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveValue(25)

    await act(async () => {
      fireEvent.blur(input)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(25)
  })

  it("writes on Enter", async () => {
    const { onCommit, input } = renderField(5)
    fireEvent.change(input, { target: { value: "7" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onCommit).toHaveBeenCalledWith(7)
  })

  it("clears the setting when the field is emptied", async () => {
    const { onCommit, input } = renderField(5)
    fireEvent.change(input, { target: { value: "" } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(onCommit).toHaveBeenCalledWith(undefined)
  })

  it("skips a draft that parses to the stored value", async () => {
    const { onCommit, input } = renderField(25)
    fireEvent.change(input, { target: { value: "25.0" } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("abandons the draft on Escape", async () => {
    const { onCommit, input } = renderField(5)
    fireEvent.change(input, { target: { value: "9" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveValue(5)
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("displays through `format` and still forwards blur / keydown", async () => {
    const onBlur = jest.fn()
    const onKeyDown = jest.fn()
    const { input } = renderField(0.8, {
      parse: (raw: string) => Number.parseFloat(raw) / 100,
      format: (v: number | undefined) => (v === undefined ? "" : String(Math.round(v * 100))),
      onBlur,
      onKeyDown,
    })
    expect(input).toHaveValue(80)
    fireEvent.keyDown(input, { key: "a" })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(onKeyDown).toHaveBeenCalled()
    expect(onBlur).toHaveBeenCalled()
  })
})
