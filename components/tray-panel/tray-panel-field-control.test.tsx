import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TrayPanelFieldControl } from "./tray-panel-field-control"
import type { TrayPanelField } from "@/lib/tray-panel/types"

describe("TrayPanelFieldControl", () => {
  it("renders a text field and reports edits", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const field: TrayPanelField = { kind: "text", id: "q", label: "Question" }
    render(<TrayPanelFieldControl field={field} value="" onChange={onChange} />)

    await user.type(screen.getByLabelText("Question"), "hi")
    expect(onChange).toHaveBeenCalled()
  })

  it("prefers the i18n key over the literal label", () => {
    const field: TrayPanelField = { kind: "text", id: "q", label: "raw", labelKey: "some.key" }
    render(<TrayPanelFieldControl field={field} value="" onChange={jest.fn()} />)
    expect(screen.getByLabelText("some.key")).toBeInTheDocument()
  })

  it("submits a submitOnEnter textarea on plain Enter", () => {
    const onSubmit = jest.fn()
    const field: TrayPanelField = {
      kind: "textarea",
      id: "p",
      label: "Prompt",
      submitOnEnter: true,
    }
    render(
      <TrayPanelFieldControl field={field} value="go" onChange={jest.fn()} onSubmit={onSubmit} />
    )
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("keeps Shift+Enter as a newline", () => {
    const onSubmit = jest.fn()
    const field: TrayPanelField = {
      kind: "textarea",
      id: "p",
      label: "Prompt",
      submitOnEnter: true,
    }
    render(
      <TrayPanelFieldControl field={field} value="go" onChange={jest.fn()} onSubmit={onSubmit} />
    )
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter", shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("never submits mid-IME-composition", () => {
    // Committing a Chinese/Japanese candidate presses Enter — submitting there
    // would send a half-typed word.
    const onSubmit = jest.fn()
    const field: TrayPanelField = {
      kind: "textarea",
      id: "p",
      label: "Prompt",
      submitOnEnter: true,
    }
    render(
      <TrayPanelFieldControl field={field} value="你" onChange={jest.fn()} onSubmit={onSubmit} />
    )
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter", isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("does not submit from a textarea that hasn't opted in", () => {
    const onSubmit = jest.fn()
    const field: TrayPanelField = { kind: "textarea", id: "p", label: "Prompt" }
    render(
      <TrayPanelFieldControl field={field} value="x" onChange={jest.fn()} onSubmit={onSubmit} />
    )
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("submits a single-line text field on Enter", () => {
    const onSubmit = jest.fn()
    const field: TrayPanelField = { kind: "text", id: "q", label: "Q" }
    render(
      <TrayPanelFieldControl field={field} value="x" onChange={jest.fn()} onSubmit={onSubmit} />
    )
    fireEvent.keyDown(screen.getByLabelText("Q"), { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("renders a switch and toggles it", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const field: TrayPanelField = { kind: "switch", id: "s", label: "Send" }
    render(<TrayPanelFieldControl field={field} value={false} onChange={onChange} />)

    await user.click(screen.getByRole("switch", { name: "Send" }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("renders a select with its options", async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()
    const field: TrayPanelField = {
      kind: "select",
      id: "t",
      label: "Target",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    }
    render(<TrayPanelFieldControl field={field} value="a" onChange={onChange} />)

    // Radix selects need userEvent — fireEvent.click doesn't open them.
    await user.click(screen.getByRole("combobox", { name: "Target" }))
    await user.click(await screen.findByRole("option", { name: "Beta" }))
    expect(onChange).toHaveBeenCalledWith("b")
  })

  it("reports a number field's numeric value", () => {
    const onChange = jest.fn()
    const field: TrayPanelField = { kind: "number", id: "n", label: "Count", min: 1 }
    render(<TrayPanelFieldControl field={field} value={1} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "7" } })
    expect(onChange).toHaveBeenCalledWith(7)
  })

  it("marks an invalid field for assistive tech", () => {
    const field: TrayPanelField = { kind: "text", id: "q", label: "Q" }
    render(<TrayPanelFieldControl field={field} value="" onChange={jest.fn()} invalid />)
    expect(screen.getByLabelText("Q")).toHaveAttribute("aria-invalid", "true")
  })

  it("renders a translated placeholder when the field declares a key", () => {
    const field: TrayPanelField = {
      kind: "text",
      id: "q",
      label: "Q",
      placeholderKey: "some.placeholder",
    }
    render(<TrayPanelFieldControl field={field} value="" onChange={jest.fn()} />)
    expect(screen.getByPlaceholderText("some.placeholder")).toBeInTheDocument()
  })
})
