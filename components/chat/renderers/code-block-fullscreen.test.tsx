/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { CodeBlockFullscreen, type CodeBlockFullscreenProps } from "./code-block-fullscreen"

const mockIsMobile = jest.fn(() => false)
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => mockIsMobile() }))

const mockBackDismiss = jest.fn()
jest.mock("@/hooks/ui/use-back-dismiss", () => ({
  useBackDismiss: (open: boolean, onDismiss: () => void) => mockBackDismiss(open, onDismiss),
}))

function setup(overrides: Partial<CodeBlockFullscreenProps> = {}) {
  const props: CodeBlockFullscreenProps = {
    open: true,
    onOpenChange: jest.fn(),
    filename: "count.mjs",
    languageLabel: "javascript",
    lineCount: 42,
    charCount: 1411,
    showLineNumbers: true,
    onToggleLineNumbers: jest.fn(),
    wordWrap: false,
    onToggleWordWrap: jest.fn(),
    copied: false,
    onCopy: jest.fn(),
    onDownload: jest.fn(),
    children: <pre>const answer = 42</pre>,
    ...overrides,
  }
  render(
    <TooltipProvider>
      <CodeBlockFullscreen {...props} />
    </TooltipProvider>
  )
  return props
}

beforeEach(() => {
  mockIsMobile.mockReturnValue(false)
})

describe("CodeBlockFullscreen", () => {
  it("puts the filename, the language badge and the stats in one header", () => {
    setup()
    const header = screen.getByTestId("code-fullscreen-header")
    expect(header).toHaveTextContent("count.mjs")
    expect(screen.getByTestId("code-fullscreen-language")).toHaveTextContent("javascript")
    expect(screen.getByTestId("code-fullscreen-stats")).toHaveTextContent(/42 lines/)
    // The filename is the dialog's accessible name.
    expect(screen.getByRole("dialog")).toHaveAccessibleName("count.mjs")
    expect(screen.getByTestId("code-fullscreen-body")).toHaveTextContent("const answer = 42")
  })

  it("titles itself with the language when there is no filename, without a duplicate badge", () => {
    setup({ filename: undefined })
    expect(screen.getByRole("dialog")).toHaveAccessibleName("javascript")
    expect(screen.queryByTestId("code-fullscreen-language")).not.toBeInTheDocument()
  })

  it("keeps every toolbar action wired", () => {
    const props = setup()
    fireEvent.click(screen.getByRole("button", { name: "Hide line numbers" }))
    fireEvent.click(screen.getByRole("button", { name: "Enable word wrap" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
    fireEvent.click(screen.getByRole("button", { name: "Download code" }))
    expect(props.onToggleLineNumbers).toHaveBeenCalledTimes(1)
    expect(props.onToggleWordWrap).toHaveBeenCalledTimes(1)
    expect(props.onCopy).toHaveBeenCalledTimes(1)
    expect(props.onDownload).toHaveBeenCalledTimes(1)
  })

  it("reflects the toggle states on the buttons", () => {
    setup({ showLineNumbers: false, wordWrap: true })
    expect(screen.getByRole("button", { name: "Show line numbers" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(screen.getByRole("button", { name: "Disable word wrap" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("closes from its own header button instead of an overlaid corner X", () => {
    const props = setup()
    // Exactly one close control: the dialog's built-in absolute X is off.
    expect(screen.getAllByRole("button", { name: /close/i })).toHaveLength(1)
    fireEvent.click(screen.getByTestId("code-fullscreen-close"))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders as a wide dialog on desktop", () => {
    setup()
    expect(screen.getByTestId("code-fullscreen")).toHaveAttribute("data-variant", "dialog")
    expect(mockBackDismiss).toHaveBeenCalledWith(false, expect.any(Function))
  })

  it("renders as a bottom sheet with the drag handle above the header on mobile", () => {
    mockIsMobile.mockReturnValue(true)
    const props = setup()
    const sheet = screen.getByTestId("code-fullscreen")
    expect(sheet).toHaveAttribute("data-variant", "sheet")
    const handle = sheet.querySelector("[data-slot='drawer-handle']")
    expect(handle).not.toBeNull()
    // Handle first, header after it: never stacked on top of each other.
    expect(
      handle!.compareDocumentPosition(screen.getByTestId("code-fullscreen-header")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // Android back closes the sheet.
    expect(mockBackDismiss).toHaveBeenCalledWith(true, expect.any(Function))
    const onDismiss = mockBackDismiss.mock.calls.at(-1)![1] as () => void
    onDismiss()
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
