import { fireEvent, render, screen } from "@testing-library/react"
import { TemplateParamPopover } from "./template-param-popover"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function anchorEl(): HTMLElement {
  const el = document.createElement("div")
  document.body.appendChild(el)
  return el
}

describe("TemplateParamPopover", () => {
  it("stays closed when no parameter is being edited", () => {
    render(
      <TemplateParamPopover
        paramId={null}
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.queryByTestId("template-param-popover")).not.toBeInTheDocument()
  })

  it("stays closed until it has an anchor to position against", () => {
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={null}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.queryByTestId("template-param-popover")).not.toBeInTheDocument()
  })

  it("shows the parameter id and its current value", () => {
    render(
      <TemplateParamPopover
        paramId="module"
        value={{ kind: "text", value: "login" }}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.getByText("module")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("login")
  })

  it("reports every keystroke as a text value", () => {
    const onChange = jest.fn()
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={onChange}
        onClose={jest.fn()}
      />
    )

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "auth" } })

    expect(onChange).toHaveBeenCalledWith({ kind: "text", value: "auth" })
  })

  it("falls back to a resource's label, which is what a shared template degrades to", () => {
    render(
      <TemplateParamPopover
        paramId="repo"
        value={{ kind: "resource", resourceKind: "repo", id: "p_1", label: "cognia-next" }}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(screen.getByRole("textbox")).toHaveValue("cognia-next")
  })

  it("closes on Enter, exactly once", () => {
    const onClose = jest.fn()
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on Escape exactly once, leaving the key to the dismiss layer", () => {
    // Handling Escape here too fired `onClose` twice: the popover's own
    // dismiss layer listens on the document, so a React `stopPropagation`
    // never reaches it.
    const onClose = jest.fn()
    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not take focus when it opens", () => {
    // The user is mid-sentence. Yanking the caret out of the textarea into a
    // panel they did not ask for is worse than no panel at all.
    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)
    textarea.focus()

    render(
      <TemplateParamPopover
        paramId="module"
        value={undefined}
        anchor={anchorEl()}
        onChange={jest.fn()}
        onClose={jest.fn()}
      />
    )

    expect(document.activeElement).toBe(textarea)
  })
})
