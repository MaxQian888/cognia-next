/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react"

const saveMock = jest.fn(async (_patch: unknown) => {})
const settingsRef: {
  settings: { lsp?: { servers?: unknown[] } } | null
} = { settings: { lsp: {} } }

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown; save: typeof saveMock }) => T): T =>
    selector({ settings: settingsRef.settings, save: saveMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations:
    (_ns: string) =>
    (key: string, params?: Record<string, string>): string =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
}))

// Stub the dialog so table tests don't drive the full form. The mock submits
// a complete entry (id included), mirroring the real dialog's contract.
jest.mock("./add-lsp-dialog", () => ({
  LspEditDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean
    onSubmit: (entry: { id: string; name: string; languages: string[]; command: string }) => void
  }) =>
    open ? (
      <div data-testid="mock-edit-dialog">
        <button
          data-testid="mock-submit"
          onClick={() =>
            onSubmit({
              id: "lsp_new",
              name: "ESLint",
              languages: ["typescript"],
              command: "/usr/bin/eslint-server",
            })
          }
        >
          submit
        </button>
      </div>
    ) : null,
}))

import { LspServersSection } from "./lsp-servers-section"

beforeEach(() => {
  saveMock.mockClear()
  settingsRef.settings = { lsp: {} }
})

describe("LspServersSection", () => {
  it("renders the four builtin rows and the empty custom state", () => {
    render(<LspServersSection />)
    expect(screen.getByTestId("lsp-builtin-typescript")).toBeInTheDocument()
    expect(screen.getByTestId("lsp-builtin-pyright")).toBeInTheDocument()
    expect(screen.getByTestId("lsp-builtin-rust-analyzer")).toBeInTheDocument()
    expect(screen.getByTestId("lsp-builtin-gopls")).toBeInTheDocument()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists a custom server with its languages + command", () => {
    settingsRef.settings = {
      lsp: {
        servers: [
          {
            id: "clangd",
            name: "clangd",
            languages: ["cpp", "c"],
            command: "/x/clangd",
            enabled: true,
          },
        ],
      },
    }
    render(<LspServersSection />)
    expect(screen.getByText("clangd")).toBeInTheDocument()
    expect(screen.getByText(/cpp.*c/i)).toBeInTheDocument()
    expect(screen.getByText("/x/clangd")).toBeInTheDocument()
  })

  it("toggling a custom server persists to lsp.servers", () => {
    settingsRef.settings = {
      lsp: {
        servers: [
          { id: "clangd", name: "clangd", languages: ["cpp"], command: "/x", enabled: true },
        ],
      },
    }
    render(<LspServersSection />)
    const row = screen.getByTestId("lsp-row-clangd")
    fireEvent.click(within(row).getByRole("switch"))
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0] as {
      lsp: { servers: Array<{ id: string; enabled: boolean }> }
    }
    expect(arg.lsp.servers[0]).toMatchObject({ id: "clangd", enabled: false })
  })

  it("removing a custom server drops it", () => {
    settingsRef.settings = {
      lsp: {
        servers: [
          { id: "clangd", name: "clangd", languages: ["cpp"], command: "/x" },
          { id: "lua", name: "lua-ls", languages: ["lua"], command: "/y" },
        ],
      },
    }
    render(<LspServersSection />)
    const row = screen.getByTestId("lsp-row-clangd")
    fireEvent.click(within(row).getByRole("button", { name: /removeAriaLabel/i }))
    const arg = saveMock.mock.calls[0][0] as { lsp: { servers: Array<{ id: string }> } }
    expect(arg.lsp.servers.map((s) => s.id)).toEqual(["lua"])
  })

  it("submitting the add dialog appends to lsp.servers", () => {
    render(<LspServersSection />)
    fireEvent.click(screen.getByRole("button", { name: /addAriaLabel/i }))
    fireEvent.click(screen.getByTestId("mock-submit"))
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0] as {
      lsp: { servers: Array<{ id: string; name: string }> }
    }
    expect(arg.lsp.servers[0]).toMatchObject({ id: "lsp_new", name: "ESLint" })
  })

  it("disabling a builtin writes an override entry with the builtin id", () => {
    render(<LspServersSection />)
    const row = screen.getByTestId("lsp-builtin-typescript")
    fireEvent.click(within(row).getByRole("switch"))
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0] as {
      lsp: { servers: Array<{ id: string; enabled: boolean }> }
    }
    expect(arg.lsp.servers[0]).toMatchObject({ id: "typescript", enabled: false })
  })

  it("shows an overridden badge + reset for a builtin with a user override", () => {
    settingsRef.settings = {
      lsp: {
        servers: [
          { id: "gopls", name: "gopls (custom)", languages: ["go"], command: "/opt/gopls" },
        ],
      },
    }
    render(<LspServersSection />)
    const row = screen.getByTestId("lsp-builtin-gopls")
    expect(within(row).getByText("badge.overridden")).toBeInTheDocument()
    expect(within(row).getByText("gopls (custom)")).toBeInTheDocument()
    // Reset removes the override.
    fireEvent.click(within(row).getByRole("button", { name: /resetAriaLabel/i }))
    const arg = saveMock.mock.calls[0][0] as { lsp: { servers: unknown[] } }
    expect(arg.lsp.servers).toEqual([])
  })
})
