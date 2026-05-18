/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn(async () => {})

const settingsRef: {
  settings: { developer?: { unsignedLspAllowed?: boolean } } | null
} = {
  settings: { developer: {} },
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: typeof saveMock }) => T): T =>
    selector({ settings: settingsRef.settings, save: saveMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations:
    (_ns: string) =>
    (key: string): string =>
      key,
}))

import { LspDevToggle } from "./lsp-dev-toggle"

beforeEach(() => {
  saveMock.mockClear()
  settingsRef.settings = { developer: {} }
})

describe("LspDevToggle", () => {
  it("renders the toggle in dev mode", () => {
    render(<LspDevToggle isDevBuild />)
    expect(screen.getByRole("switch")).toBeInTheDocument()
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("warning")).toBeInTheDocument()
  })

  it("returns null in production builds", () => {
    const { container } = render(<LspDevToggle isDevBuild={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("reflects the saved value (off by default)", () => {
    render(<LspDevToggle isDevBuild />)
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "unchecked")
  })

  it("reflects the saved value (on)", () => {
    settingsRef.settings = { developer: { unsignedLspAllowed: true } }
    render(<LspDevToggle isDevBuild />)
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked")
  })

  it("persists the new value via the settings store on click", () => {
    render(<LspDevToggle isDevBuild />)
    fireEvent.click(screen.getByRole("switch"))
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        developer: expect.objectContaining({ unsignedLspAllowed: true }),
      })
    )
  })

  it("merges with existing developer settings (does not clobber sibling fields)", () => {
    // Hypothetical sibling field — the toggle must not overwrite it.
    settingsRef.settings = {
      developer: {
        unsignedLspAllowed: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ siblingFlag: 7 } as any),
      },
    }
    render(<LspDevToggle isDevBuild />)
    fireEvent.click(screen.getByRole("switch"))
    const arg = saveMock.mock.calls[0][0] as {
      developer: { unsignedLspAllowed?: boolean; siblingFlag?: number }
    }
    expect(arg.developer.unsignedLspAllowed).toBe(true)
    expect(arg.developer.siblingFlag).toBe(7)
  })
})
