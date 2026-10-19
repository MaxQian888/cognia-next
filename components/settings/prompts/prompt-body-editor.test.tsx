/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import type { PromptValidationIssue } from "@/lib/prompts/template"
import { PromptBodyEditor } from "./prompt-body-editor"

function Harness(props: { initial: string; issues?: PromptValidationIssue[]; readOnly?: boolean }) {
  const [value, setValue] = useState(props.initial)
  return (
    <PromptBodyEditor
      value={value}
      onChange={setValue}
      variables={[
        { name: "topic", required: true, maxChars: 80 },
        { name: "lang", required: false, maxChars: 16 },
      ]}
      issues={props.issues}
      maxChars={40}
      readOnly={props.readOnly}
      label="Body"
    />
  )
}

beforeAll(() => {
  // A frame runs after React commits, as in a browser.
  jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => window.setTimeout(() => callback(0), 0))
})

it("inserts a variable at the caret", async () => {
  render(<Harness initial="Write about ." />)
  const area = screen.getByLabelText("Body") as HTMLTextAreaElement
  area.setSelectionRange(12, 12)
  await userEvent.click(screen.getByRole("button", { name: "Insert topic" }))
  expect(area.value).toBe("Write about {{topic}}.")
  await waitFor(() => expect(area.selectionStart).toBe(21))
  expect(area).toHaveFocus()
})

it("replaces a selection with the variable", () => {
  render(<Harness initial="Write about X." />)
  const area = screen.getByLabelText("Body") as HTMLTextAreaElement
  area.setSelectionRange(12, 13)
  fireEvent.click(screen.getByRole("button", { name: "Insert lang" }))
  expect(area.value).toBe("Write about {{lang}}.")
})

it("lists every issue and flags the length", () => {
  render(
    <Harness
      initial={"x".repeat(41)}
      issues={[
        { code: "empty" },
        { code: "too-long", limit: 40, length: 41 },
        { code: "malformed-placeholder" },
        { code: "unknown-variable", name: "nope" },
        { code: "missing-variable", name: "topic" },
        { code: "missing-fragment", fragment: '"safe"' },
        { code: "pii" },
        { code: "not-editable" },
      ]}
    />
  )
  const issues = screen.getByTestId("prompt-body-issues")
  expect(issues.children).toHaveLength(8)
  expect(issues).toHaveTextContent("41 characters; the limit is 40.")
  expect(issues).toHaveTextContent("A placeholder is malformed")
  expect(issues).toHaveTextContent('Must keep ""safe"": the reply parser depends on it.')
  expect(screen.getByLabelText("Body")).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByText("41 / 40")).toBeInTheDocument()
})

it("hides the chips and blocks typing when read-only", () => {
  render(<Harness initial="Fixed." readOnly />)
  expect(screen.queryByRole("button", { name: "Insert topic" })).toBeNull()
  expect(screen.getByLabelText("Body")).toHaveAttribute("readonly")
})
