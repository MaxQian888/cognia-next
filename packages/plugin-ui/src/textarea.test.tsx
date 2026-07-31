import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Textarea } from "./textarea"

describe("Textarea", () => {
  it("renders a native textarea a label can point at", () => {
    render(
      <>
        <label htmlFor="notes">Notes</label>
        <Textarea id="notes" defaultValue="draft" />
      </>
    )

    const field = screen.getByRole("textbox", { name: "Notes" })
    expect(field.tagName).toBe("TEXTAREA")
    expect(field).toHaveAttribute("data-slot", "textarea")
    expect(field).toHaveValue("draft")
  })

  it("accepts typed input and reports every change", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Textarea aria-label="Notes" onChange={onChange} />)

    const field = screen.getByRole("textbox", { name: "Notes" })
    await user.type(field, "hi")

    expect(field).toHaveValue("hi")
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("keeps newlines rather than swallowing Enter like an Input would", async () => {
    const user = userEvent.setup()
    render(<Textarea aria-label="Notes" />)

    const field = screen.getByRole("textbox", { name: "Notes" })
    await user.type(field, "one{Enter}two")

    expect(field).toHaveValue("one\ntwo")
  })

  it("auto-grows from CSS, not from a resize-observer loop", () => {
    render(<Textarea aria-label="Notes" />)

    // `field-sizing-content` is what keeps a plugin's textarea from fighting the
    // host for layout passes; losing it silently reintroduces a fixed height.
    expect(screen.getByRole("textbox").className).toContain("field-sizing-content")
  })

  it("ignores interaction while disabled", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    render(<Textarea aria-label="Notes" disabled onChange={onChange} />)

    const field = screen.getByRole("textbox", { name: "Notes" })
    await user.type(field, "hi")

    expect(field).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("surfaces invalid state for the host's error ring", () => {
    render(<Textarea aria-label="Notes" aria-invalid />)

    const field = screen.getByRole("textbox", { name: "Notes" })
    expect(field).toBeInvalid()
    expect(field.className).toContain("aria-invalid:border-destructive")
  })

  it("shows a placeholder the caller supplies", () => {
    render(<Textarea aria-label="Notes" placeholder="Describe the issue" />)

    expect(screen.getByPlaceholderText("Describe the issue")).toHaveAttribute(
      "data-slot",
      "textarea"
    )
  })

  it("merges caller classes onto the field instead of dropping them", () => {
    render(<Textarea aria-label="Notes" className="min-h-40 font-mono" />)

    const field = screen.getByRole("textbox")
    expect(field.className).toContain("font-mono")
    // cn() resolved min-h-16 vs min-h-40 rather than emitting both.
    expect(field.className).toContain("min-h-40")
    expect(field.className).not.toContain("min-h-16")
  })
})
