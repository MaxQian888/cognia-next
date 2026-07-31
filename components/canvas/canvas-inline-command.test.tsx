/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { CanvasInlineCommand } from "./canvas-inline-command"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// cmdk scrolls the active item into view; jsdom has no layout.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

function setup(overrides: Partial<React.ComponentProps<typeof CanvasInlineCommand>> = {}) {
  const props = {
    running: false,
    onAction: jest.fn(),
    onSaveVersion: jest.fn(),
    onTriggerSuggestions: jest.fn(),
    onCreateDocument: jest.fn(),
    ...overrides,
  }
  render(<CanvasInlineCommand {...props} />)
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
