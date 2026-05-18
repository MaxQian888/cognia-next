/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars && typeof vars.source === "string") return `${key}:${vars.source}`
    return key
  },
}))

const upsertPluginMock = jest.fn(async (..._args: unknown[]) => ({}) as never)
jest.mock("@/lib/db/plugins", () => ({
  upsertPlugin: (...args: unknown[]) => upsertPluginMock(...args),
}))

import { PluginImportDialog } from "./plugin-import-dialog"
import { usePluginsStore } from "@/stores/plugins"

beforeEach(() => {
  upsertPluginMock.mockClear()
  usePluginsStore.setState({ importStaging: null })
})

describe("PluginImportDialog", () => {
  it("does not render when no staging is set", () => {
    const { container } = render(<PluginImportDialog />)
    expect(container.querySelector("[role='dialog']")).toBeNull()
  })

  it("renders staged drafts and parse errors", () => {
    usePluginsStore.setState({
      importStaging: {
        drafts: [
          {
            id: "p1",
            name: "Plugin 1",
            version: "1.0.0",
            manifest: { id: "p1", type: "frontend" },
            sourceLabel: "manifest.json",
          },
        ],
        sourceLabel: "test bundle",
        parseErrors: [{ name: "bad.json", error: "syntax" }],
      },
    })
    render(<PluginImportDialog />)
    expect(screen.getByText("Plugin 1")).toBeInTheDocument()
    expect(screen.getByText(/p1 ·/)).toBeInTheDocument()
    expect(screen.getByText(/bad.json/)).toBeInTheDocument()
  })

  it("confirm calls upsertPlugin once per draft and clears staging", async () => {
    usePluginsStore.setState({
      importStaging: {
        drafts: [
          {
            id: "p1",
            name: "Plugin 1",
            version: "1.0.0",
            manifest: { id: "p1", type: "frontend", capabilities: ["tools"] },
            sourceLabel: "manifest.json",
          },
          {
            id: "p2",
            name: "Plugin 2",
            version: "0.5.0",
            manifest: { id: "p2", type: "python" },
            sourceLabel: "manifest.json",
          },
        ],
        sourceLabel: "test bundle",
        parseErrors: [],
      },
    })
    render(<PluginImportDialog />)
    fireEvent.click(screen.getByText(/^confirm:2/))
    await waitFor(() => expect(usePluginsStore.getState().importStaging).toBeNull())
    expect(upsertPluginMock).toHaveBeenCalledTimes(2)
  })

  it("cancel clears staging without calling upsertPlugin", () => {
    usePluginsStore.setState({
      importStaging: {
        drafts: [
          {
            id: "p1",
            name: "Plugin 1",
            version: "1.0.0",
            manifest: { id: "p1" },
            sourceLabel: "manifest.json",
          },
        ],
        sourceLabel: "test bundle",
        parseErrors: [],
      },
    })
    render(<PluginImportDialog />)
    fireEvent.click(screen.getByText("cancel"))
    expect(usePluginsStore.getState().importStaging).toBeNull()
    expect(upsertPluginMock).not.toHaveBeenCalled()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    usePluginsStore.setState({
      importStaging: {
        drafts: [
          {
            id: "p1",
            name: "Plugin 1",
            version: "1.0.0",
            manifest: { id: "p1" },
            sourceLabel: "manifest.json",
          },
        ],
        sourceLabel: "test bundle",
        parseErrors: [],
      },
    })
    render(<PluginImportDialog />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })
})
