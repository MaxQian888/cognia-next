/**
 * @jest-environment jsdom
 */
import { useState } from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { CanvasInlineCommand } from "./canvas-inline-command"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// cmdk scrolls the active item into view; jsdom has no layout.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

/**
 * The palette is controlled now: its open flag is the document's
 * `aiWorkbench.isInlineCommandOpen`, so it survives switching documents. This
 * harness stands in for the owner that holds it.
 */
function ControlledPalette(
  props: Omit<React.ComponentProps<typeof CanvasInlineCommand>, "open" | "onOpenChange">
) {
  const [open, setOpen] = useState(false)
  return <CanvasInlineCommand {...props} open={open} onOpenChange={setOpen} />
}

function setup(
  overrides: Partial<
    Omit<React.ComponentProps<typeof CanvasInlineCommand>, "open" | "onOpenChange">
  > = {}
) {
  const props = {
    running: false,
    onAction: jest.fn(),
    onSaveVersion: jest.fn(),
    onTriggerSuggestions: jest.fn(),
    onCreateDocument: jest.fn(),
    ...overrides,
  }
  render(<ControlledPalette {...props} />)
  return props
}

function openPalette() {
  act(() => {
    window.dispatchEvent(new CustomEvent("canvas-inline-command"))
  })
}

describe("CanvasInlineCommand", () => {
  it("stays closed until the canvas-inline-command event fires", () => {
    setup()
    expect(screen.queryByPlaceholderText("placeholder")).not.toBeInTheDocument()
    openPalette()
    expect(screen.getByPlaceholderText("placeholder")).toBeInTheDocument()
  })

  it("toggles closed when the event fires again", () => {
    setup()
    openPalette()
    expect(screen.getByPlaceholderText("placeholder")).toBeInTheDocument()
    openPalette()
    expect(screen.queryByPlaceholderText("placeholder")).not.toBeInTheDocument()
  })

  it("runs an AI action and closes on select", () => {
    const props = setup()
    openPalette()
    fireEvent.click(screen.getByText("review"))
    expect(props.onAction).toHaveBeenCalledWith("review")
    expect(screen.queryByPlaceholderText("placeholder")).not.toBeInTheDocument()
  })

  it("expands translate into per-language commands", () => {
    const props = setup()
    openPalette()
    // Chinese label comes from TRANSLATE_LANGUAGES; the item text joins it.
    fireEvent.click(screen.getByText(/中文/))
    expect(props.onAction).toHaveBeenCalledWith("translate", { targetLanguage: "chinese" })
  })

  it("triggers document commands", () => {
    const props = setup()
    openPalette()
    fireEvent.click(screen.getByText("newDocument"))
    expect(props.onCreateDocument).toHaveBeenCalled()
  })

  it("triggers suggest and save-version commands", () => {
    const props = setup()
    openPalette()
    fireEvent.click(screen.getByText("suggest"))
    expect(props.onTriggerSuggestions).toHaveBeenCalled()
    openPalette()
    fireEvent.click(screen.getByText("saveVersion"))
    expect(props.onSaveVersion).toHaveBeenCalled()
  })

  it("disables AI actions while a generation is running", () => {
    const props = setup({ running: true })
    openPalette()
    fireEvent.click(screen.getByText("review"))
    expect(props.onAction).not.toHaveBeenCalled()
  })
})
