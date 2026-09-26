/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { useInlineRename, type UseInlineRenameOptions } from "./use-inline-rename"

function Field(props: UseInlineRenameOptions & { onOuterKeyDown?: () => void }) {
  const { onOuterKeyDown, ...options } = props
  const { inputProps } = useInlineRename(options)
  if (options.active === false) return <span>idle</span>
  return (
    <div onKeyDown={onOuterKeyDown}>
      <input aria-label="name" {...inputProps} />
    </div>
  )
}

function setup(overrides: Partial<UseInlineRenameOptions> = {}) {
  const onCommit = jest.fn()
  const onCancel = jest.fn()
  const onOuterKeyDown = jest.fn()
  const props = { initial: "Old", onCommit, onCancel, onOuterKeyDown, ...overrides }
  const utils = render(<Field {...props} />)
  return { ...utils, props, onCommit, onCancel, onOuterKeyDown }
}

test("focuses the field with the name selected", () => {
  setup()
  const input = screen.getByLabelText("name") as HTMLInputElement
  expect(input).toHaveFocus()
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(3)
})

test("commits the trimmed name once, even with the blur that follows Enter", () => {
  const { onCommit, onCancel } = setup()
  const input = screen.getByLabelText("name")
  fireEvent.change(input, { target: { value: "  New  " } })
  fireEvent.keyDown(input, { key: "Enter" })
  fireEvent.blur(input)
  expect(onCommit).toHaveBeenCalledTimes(1)
  expect(onCommit).toHaveBeenCalledWith("New")
  expect(onCancel).not.toHaveBeenCalled()
})

test("ignores the Enter that picks an IME candidate", () => {
  const { onCommit } = setup()
  const input = screen.getByLabelText("name")
  fireEvent.change(input, { target: { value: "新" } })
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
  fireEvent.keyDown(input, { key: "Enter", isComposing: true })
  expect(onCommit).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(onCommit).toHaveBeenCalledWith("新")
})

test("treats a blank or unchanged name as a cancel", () => {
  const { onCommit, onCancel } = setup()
  const input = screen.getByLabelText("name")
  fireEvent.change(input, { target: { value: "   " } })
  fireEvent.blur(input)
  expect(onCommit).not.toHaveBeenCalled()
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test("Escape cancels without reaching the list or drawer, and the blur does not commit", () => {
  const { onCommit, onCancel, onOuterKeyDown } = setup()
  const input = screen.getByLabelText("name")
  fireEvent.change(input, { target: { value: "Draft" } })
  fireEvent.keyDown(input, { key: "Escape" })
  fireEvent.blur(input)
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onCommit).not.toHaveBeenCalled()
  expect(onOuterKeyDown).not.toHaveBeenCalled()
})

test("re-arms from the current name each time it opens", () => {
  const { rerender, props, onCommit } = setup({ active: true })
  const input = screen.getByLabelText("name")
  fireEvent.change(input, { target: { value: "First" } })
  fireEvent.keyDown(input, { key: "Enter" })
  rerender(<Field {...props} active={false} initial="First" />)
  rerender(<Field {...props} active initial="First" />)
  const reopened = screen.getByLabelText("name") as HTMLInputElement
  expect(reopened.value).toBe("First")
  fireEvent.change(reopened, { target: { value: "Second" } })
  fireEvent.keyDown(reopened, { key: "Enter" })
  expect(onCommit).toHaveBeenLastCalledWith("Second")
  expect(onCommit).toHaveBeenCalledTimes(2)
})
