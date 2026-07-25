/**
 * @jest-environment jsdom
 */

import { render, screen, act, cleanup } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockAvailability = jest.fn<boolean | null, [string]>(() => null)
jest.mock("@/lib/appearance/font-availability", () => {
  const actual = jest.requireActual("@/lib/appearance/font-availability")
  return {
    ...actual,
    isFontFamilyAvailable: (family: string) => mockAvailability(family),
  }
})

import { TerminalFontPreview, TERMINAL_DEFAULT_FONT_STACK } from "./terminal-font-preview"

function sample(): HTMLElement {
  return screen.getByTestId("terminal-font-preview-sample")
}

beforeEach(() => {
  mockAvailability.mockReset().mockReturnValue(null)
  document.documentElement.classList.remove("dark")
})

describe("TerminalFontPreview", () => {
  it("renders the configured typography on the specimen", () => {
    render(
      <TerminalFontPreview
        fontFamily='"Fira Code", monospace'
        fontSize={18}
        fontWeight="600"
        lineHeight={1.4}
        letterSpacing={1}
      />
    )
    expect(sample()).toHaveStyle({
      fontFamily: '"Fira Code", monospace',
      fontSize: "18px",
      fontWeight: "600",
      lineHeight: "1.4",
      letterSpacing: "1px",
    })
  })

  it("falls back to the terminal's own default stack when unset", () => {
    render(<TerminalFontPreview fontSize={13} />)
    expect(sample()).toHaveStyle({ fontFamily: TERMINAL_DEFAULT_FONT_STACK })
    // The probed family is the first entry of that default stack.
    expect(mockAvailability).toHaveBeenCalledWith("MesloLGS NF")
  })

  it("warns when the requested family is not installed", async () => {
    mockAvailability.mockReturnValue(false)
    await act(async () => {
      render(<TerminalFontPreview fontFamily='"No Such Font", monospace' fontSize={13} />)
    })
    expect(screen.getByTestId("terminal-font-preview-missing").textContent).toContain(
      "No Such Font"
    )
  })

  it("stays silent when availability cannot be determined", async () => {
    mockAvailability.mockReturnValue(null)
    await act(async () => {
      render(<TerminalFontPreview fontFamily='"No Such Font", monospace' fontSize={13} />)
    })
    expect(screen.queryByTestId("terminal-font-preview-missing")).toBeNull()
  })

  it("reports the resolved family and size when the font is available", async () => {
    mockAvailability.mockReturnValue(true)
    await act(async () => {
      render(<TerminalFontPreview fontFamily="Menlo" fontSize={16} />)
    })
    expect(screen.getByTestId("terminal-font-preview").textContent).toContain("Menlo")
    expect(screen.getByTestId("terminal-font-preview").textContent).toContain("16")
  })

  it("paints a named color scheme's own background", () => {
    render(<TerminalFontPreview fontSize={13} colorScheme="dracula" />)
    const surface = sample().parentElement as HTMLElement
    // Dracula's background, not the app surface.
    expect(surface.style.backgroundColor).not.toBe("")
    expect(surface.style.color).not.toBe("")
  })

  it("follows the app's dark class for the auto scheme", () => {
    document.documentElement.classList.add("dark")
    render(<TerminalFontPreview fontSize={13} colorScheme="auto" />)
    const darkBg = (sample().parentElement as HTMLElement).style.backgroundColor
    document.documentElement.classList.remove("dark")
    cleanup()
    render(<TerminalFontPreview fontSize={13} colorScheme="auto" />)
    expect((sample().parentElement as HTMLElement).style.backgroundColor).not.toBe(darkBg)
  })

  it("re-probes once the document's fonts settle", async () => {
    // A bundled @font-face can still be loading on first paint; the second
    // probe is what stops a loading font from being reported as missing.
    const original = Object.getOwnPropertyDescriptor(document, "fonts")
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve(undefined) },
    })
    mockAvailability.mockReturnValueOnce(false).mockReturnValue(true)
    await act(async () => {
      render(<TerminalFontPreview fontFamily="MesloLGS NF" fontSize={13} />)
    })
    expect(mockAvailability.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByTestId("terminal-font-preview-missing")).toBeNull()
    if (original) Object.defineProperty(document, "fonts", original)
    else Reflect.deleteProperty(document, "fonts")
  })

  it("re-probes when the requested family changes", () => {
    const { rerender } = render(<TerminalFontPreview fontFamily="Menlo" fontSize={13} />)
    expect(mockAvailability).toHaveBeenCalledWith("Menlo")
    rerender(<TerminalFontPreview fontFamily="Consolas" fontSize={13} />)
    expect(mockAvailability).toHaveBeenCalledWith("Consolas")
  })
})
