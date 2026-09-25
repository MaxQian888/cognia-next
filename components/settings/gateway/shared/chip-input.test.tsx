import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ChipInput } from "./chip-input"

function setup(
  values: string[] = [],
  onCommit = jest.fn(),
  validate?: (value: string) => string | null
) {
  render(
    <ChipInput
      values={values}
      onCommit={onCommit}
      placeholder="add an entry"
      ariaLabel="Allowlist"
      addLabel="Add"
      removeLabel="Remove"
      validate={validate}
    />
  )
  return { onCommit }
}

const digitsOnly = (value: string) => (/^\d+$/.test(value) ? null : "digits only")

describe("ChipInput", () => {
  it("commits the draft on Enter", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup(["a"])

    await user.type(screen.getByLabelText("Allowlist"), "b{Enter}")

    expect(onCommit).toHaveBeenCalledWith(["a", "b"])
  })

  it("commits the draft on blur, so typing without Enter is not silently lost", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup([])

    await user.type(screen.getByLabelText("Allowlist"), "10.0.0.0/8")
    await user.tab()

    expect(onCommit).toHaveBeenCalledWith(["10.0.0.0/8"])
  })

  it("commits via the add button", async () => {
    // Regression: the button used to carry onClick. mousedown blurs the input,
    // whose onBlur clears the draft and disables the button, so the click never
    // landed and the button was decorative. Committing on mousedown fixes it.
    const user = userEvent.setup()
    const { onCommit } = setup([])

    await user.type(screen.getByLabelText("Allowlist"), "fast")
    await user.click(screen.getByLabelText("Add Allowlist"))

    expect(onCommit).toHaveBeenCalledWith(["fast"])
  })

  it("qualifies the add button label with the field so sibling inputs stay distinguishable", () => {
    setup([])

    expect(screen.getByLabelText("Add Allowlist")).toBeInTheDocument()
    expect(screen.queryByLabelText("Add")).not.toBeInTheDocument()
  })

  it("ignores blank and duplicate entries", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup(["dup"])

    await user.type(screen.getByLabelText("Allowlist"), "   {Enter}")
    await user.type(screen.getByLabelText("Allowlist"), "dup{Enter}")

    expect(onCommit).not.toHaveBeenCalled()
  })

  it("removes an entry", async () => {
    const user = userEvent.setup()
    const { onCommit } = setup(["a", "b"])

    await user.click(screen.getByLabelText("Remove a"))

    expect(onCommit).toHaveBeenCalledWith(["b"])
  })

  describe("validation", () => {
    it("keeps an invalid draft in place with the reason, instead of committing it", async () => {
      const user = userEvent.setup()
      const { onCommit } = setup([], jest.fn(), digitsOnly)
      const input = screen.getByLabelText("Allowlist")

      await user.type(input, "abc{Enter}")

      expect(onCommit).not.toHaveBeenCalled()
      expect(input).toHaveValue("abc")
      expect(input).toHaveAttribute("aria-invalid", "true")
      expect(screen.getByRole("alert")).toHaveTextContent("digits only")
      expect(input).toHaveAccessibleDescription("digits only")
    })

    it("does not drop an invalid draft on blur either", async () => {
      const user = userEvent.setup()
      const { onCommit } = setup([], jest.fn(), digitsOnly)

      await user.type(screen.getByLabelText("Allowlist"), "abc")
      await user.tab()

      expect(onCommit).not.toHaveBeenCalled()
      expect(screen.getByLabelText("Allowlist")).toHaveValue("abc")
    })

    it("clears the error once the draft is edited, then commits a valid value", async () => {
      const user = userEvent.setup()
      const { onCommit } = setup([], jest.fn(), digitsOnly)
      const input = screen.getByLabelText("Allowlist")

      await user.type(input, "abc{Enter}")
      await user.clear(input)
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()

      await user.type(input, "429{Enter}")
      expect(onCommit).toHaveBeenCalledWith(["429"])
    })

    it("validates the trimmed value", async () => {
      const user = userEvent.setup()
      const validate = jest.fn(digitsOnly)
      setup([], jest.fn(), validate)

      await user.type(screen.getByLabelText("Allowlist"), "  503  {Enter}")

      expect(validate).toHaveBeenCalledWith("503")
    })
  })
})
