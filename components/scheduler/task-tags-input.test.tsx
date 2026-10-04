import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { MAX_TAGS, TaskTagsInput, mergeTags, parseTagText } from "./task-tags-input"

function Harness({ initial = [] as string[], onChange = jest.fn() }) {
  const [tags, setTags] = useState<string[]>(initial)
  return (
    <TaskTagsInput
      value={tags}
      onChange={(next) => {
        setTags(next)
        onChange(next)
      }}
    />
  )
}

function chips(): string[] {
  return screen.queryAllByTestId("task-tags-input-chip").map((chip) => chip.textContent ?? "")
}

describe("parseTagText / mergeTags", () => {
  it("splits on commas and newlines, trims, and strips a leading #", () => {
    expect(parseTagText(" #ops, nightly ,\nreports,, ")).toEqual(["ops", "nightly", "reports"])
  })

  it("caps a tag's length", () => {
    expect(parseTagText("x".repeat(40))[0]).toHaveLength(32)
  })

  it("drops case-insensitive duplicates and stops at the cap", () => {
    expect(mergeTags(["Reports"], ["reports", "ops"])).toEqual(["Reports", "ops"])
    const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${i}`)
    expect(mergeTags([], many)).toHaveLength(MAX_TAGS)
  })
})

describe("TaskTagsInput", () => {
  it("adds a tag on Enter without submitting the surrounding form", () => {
    const onSubmit = jest.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>
    )
    const field = screen.getByTestId("task-tags-input-field")
    fireEvent.change(field, { target: { value: "nightly" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(chips()).toEqual(["nightly"])
    expect(onSubmit).not.toHaveBeenCalled()
    expect(field).toHaveValue("")
  })

  it("commits pasted comma-separated text as several tags", () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId("task-tags-input-field"), {
      target: { value: "a, b, a," },
    })
    expect(chips()).toEqual(["a", "b"])
  })

  it("removes the last tag on Backspace in an empty field, and one tag by its button", () => {
    const onChange = jest.fn()
    render(<Harness initial={["a", "b", "c"]} onChange={onChange} />)
    fireEvent.keyDown(screen.getByTestId("task-tags-input-field"), { key: "Backspace" })
    expect(chips()).toEqual(["a", "b"])
    fireEvent.click(screen.getByRole("button", { name: "Remove tag a" }))
    expect(chips()).toEqual(["b"])
    expect(onChange).toHaveBeenLastCalledWith(["b"])
  })

  it("commits leftover text when the field loses focus", () => {
    render(<Harness />)
    const field = screen.getByTestId("task-tags-input-field")
    fireEvent.change(field, { target: { value: "ops" } })
    fireEvent.blur(field)
    expect(chips()).toEqual(["ops"])
  })

  it("disables the field once the cap is reached", () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`)
    render(<Harness initial={full} />)
    expect(screen.getByTestId("task-tags-input-field")).toBeDisabled()
  })
})
