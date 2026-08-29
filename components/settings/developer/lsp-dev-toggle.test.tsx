/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn(async (_patch: unknown) => {})

const settingsRef: {
  settings: {
    lsp?: { servers?: unknown[]; unsignedAllowed?: boolean }
  } | null
} = {
  settings: { lsp: { servers: [] } },
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
  settingsRef.settings = { lsp: { servers: [] } }
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
    settingsRef.settings = { lsp: { servers: [], unsignedAllowed: true } }
    render(<LspDevToggle isDevBuild />)
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked")
  })

  it("persists the new value via the settings store on click", () => {
    render(<LspDevToggle isDevBuild />)
    fireEvent.click(screen.getByRole("switch"))
    expect(saveMock).toHaveBeenCalledTimes(1)
    // The policy (`lib/plugin/vscode-shim/lsp-binary-policy.ts`) reads
    // `lsp.unsignedAllowed`; writing the pre-unification
    // `developer.unsignedLspAllowed` here made the toggle inert, because the
    // startup migration moves that field and then clears it.
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lsp: expect.objectContaining({ unsignedAllowed: true }),
      })
    )
  })

  it("merges with the existing lsp slice (does not clobber the server list)", () => {
    settingsRef.settings = {
      lsp: {
        servers: [{ id: "pyright" }],
        unsignedAllowed: false,
      },
    }
    render(<LspDevToggle isDevBuild />)
    fireEvent.click(screen.getByRole("switch"))
    const arg = saveMock.mock.calls[0][0] as {
      lsp: { unsignedAllowed?: boolean; servers?: Array<{ id: string }> }
    }
    expect(arg.lsp.unsignedAllowed).toBe(true)
    expect(arg.lsp.servers).toEqual([{ id: "pyright" }])
  })

  it("still writes a server list when the lsp slice is absent", () => {
    settingsRef.settings = {}
    render(<LspDevToggle isDevBuild />)
    fireEvent.click(screen.getByRole("switch"))
    const arg = saveMock.mock.calls[0][0] as { lsp: { servers?: unknown[] } }
    expect(arg.lsp.servers).toEqual([])
  })
})
