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

  // Import is the one install path that skips the marketplace pre-install
  // chain, so the review list is the only place the user can see what accepting
  // a hand-written manifest grants. It used to show name/id/version/type only.
  describe("grant read-out", () => {
    const stage = (manifest: Record<string, unknown>) =>
      usePluginsStore.setState({
        importStaging: {
          drafts: [
            {
              id: "p1",
              name: "Plugin 1",
              version: "1.0.0",
              manifest: { id: "p1", ...manifest },
              sourceLabel: "manifest.json",
            },
          ],
          sourceLabel: "test bundle",
          parseErrors: [],
        },
      })

    it("lists declared permissions before the user can confirm", () => {
      stage({ permissions: ["filesystem", "network"] })
      render(<PluginImportDialog />)
      expect(screen.getByText("filesystem")).toBeInTheDocument()
      expect(screen.getByText("network")).toBeInTheDocument()
      expect(screen.getByText("permissionsDeclared")).toBeInTheDocument()
    })

    it("separates optional permissions from declared ones", () => {
      stage({ permissions: ["filesystem"], optionalPermissions: ["clipboard"] })
      render(<PluginImportDialog />)
      expect(screen.getByText("permissionsDeclared")).toBeInTheDocument()
      expect(screen.getByText("permissionsOptional")).toBeInTheDocument()
      expect(screen.getByText("clipboard")).toBeInTheDocument()
    })

    it("surfaces the capabilities that get persisted to the plugin row", () => {
      stage({ capabilities: ["tools", "panels"] })
      render(<PluginImportDialog />)
      expect(screen.getByText("tools")).toBeInTheDocument()
      expect(screen.getByText("panels")).toBeInTheDocument()
    })

    it("says so explicitly when a manifest declares nothing", () => {
      stage({ type: "frontend" })
      render(<PluginImportDialog />)
      expect(screen.getByText("permissionsNone")).toBeInTheDocument()
    })

    // The manifest is untrusted JSON — a non-array or mixed-type field must not
    // throw and must not smuggle a non-string into the permission list.
    it("ignores malformed permission/capability fields", () => {
      stage({ permissions: "filesystem", capabilities: [1, "tools", null] })
      render(<PluginImportDialog />)
      expect(screen.getByTestId("import-grants-p1")).toBeInTheDocument()
      expect(screen.getByText("tools")).toBeInTheDocument()
      expect(screen.queryByText("permissionsDeclared")).not.toBeInTheDocument()
    })
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
