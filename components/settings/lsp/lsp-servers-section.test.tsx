/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

const saveMock = jest.fn(async () => {})
const settingsRef: {
  settings: { developer?: { userLspServers?: unknown[] } } | null
} = { settings: { developer: {} } }

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

// Stub the AddLspDialog so we don't have to drive the form for table tests.
jest.mock("./add-lsp-dialog", () => ({
  AddLspDialog: ({
    open,
    onAdd,
  }: {
    open: boolean
    onAdd: (entry: { name: string; languages: string[]; command: string }) => void
  }) =>
    open ? (
      <div data-testid="mock-add-dialog">
        <button
          data-testid="mock-add-submit"
          onClick={() =>
            onAdd({
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
  settingsRef.settings = { developer: {} }
})

describe("LspServersSection", () => {
  it("renders the empty state when no entries are configured", () => {
    render(<LspServersSection />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists every entry with its languages + command", () => {
    settingsRef.settings = {
      developer: {
        userLspServers: [
          {
            id: "e1",
            name: "ESLint",
            languages: ["typescript", "javascript"],
            command: "/x/eslint",
            enabled: true,
          },
        ],
      },
    }
    render(<LspServersSection />)
    expect(screen.getByText("ESLint")).toBeInTheDocument()
    expect(screen.getByText(/typescript.*javascript/i)).toBeInTheDocument()
    expect(screen.getByText("/x/eslint")).toBeInTheDocument()
  })

  it("toggling the enabled switch persists the new value", () => {
    settingsRef.settings = {
      developer: {
        userLspServers: [
          {
            id: "e1",
            name: "ESLint",
            languages: ["typescript"],
            command: "/x/eslint",
            enabled: true,
          },
        ],
      },
    }
    render(<LspServersSection />)
    const sw = screen.getByRole("switch")
    fireEvent.click(sw)
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0] as {
      developer: { userLspServers: Array<{ id: string; enabled: boolean }> }
    }
    expect(arg.developer.userLspServers[0]).toMatchObject({ id: "e1", enabled: false })
  })

  it("clicking remove drops the entry", () => {
    settingsRef.settings = {
      developer: {
        userLspServers: [
          { id: "e1", name: "ESLint", languages: ["typescript"], command: "/x" },
          { id: "e2", name: "Pyright", languages: ["python"], command: "/y" },
        ],
      },
    }
    render(<LspServersSection />)
    fireEvent.click(screen.getAllByRole("button")[1]) // second button is the first row's trash icon
    expect(saveMock).toHaveBeenCalled()
    const arg = saveMock.mock.calls[0][0] as {
      developer: { userLspServers: Array<{ id: string }> }
    }
    expect(arg.developer.userLspServers.map((e) => e.id)).not.toContain("e1")
  })

  it("submitting the add dialog appends a new entry with a generated id", () => {
    render(<LspServersSection />)
    fireEvent.click(screen.getByRole("button", { name: /addAriaLabel/i }))
    fireEvent.click(screen.getByTestId("mock-add-submit"))
    expect(saveMock).toHaveBeenCalledTimes(1)
    const arg = saveMock.mock.calls[0][0] as {
      developer: { userLspServers: Array<{ id: string; name: string; enabled?: boolean }> }
    }
    const added = arg.developer.userLspServers[0]
    expect(added.name).toBe("ESLint")
    expect(added.enabled).toBe(true)
    expect(added.id).toMatch(/^lsp_/)
  })
})
