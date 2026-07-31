/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${Object.values(vals).join(",")}` : key,
}))

const saveMock = jest.fn()
let mockSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockSettings, save: saveMock }),
}))

// Stub the catalog aggregate so suggestion/known sets are deterministic and
// the component doesn't reach for Dexie / the plugin store in jsdom.
const getToolCatalogMock = jest.fn()
jest.mock("@/lib/tools/tool-catalog", () => ({
  PLUGIN_TOOLS_SERVER_NAME: "cognia-plugin-tools",
  getToolCatalog: () => getToolCatalogMock(),
}))
jest.mock("@/lib/settings/builtin-tools", () => ({ BUILTIN_SERVER_NAME: "cognia-tools" }))

import { ToolSearchRuntimeCard } from "./tool-search-runtime-card"

// Render and flush the mount-time catalog load inside act (waitFor wraps in
// act), so the async setState never lands after the test body un-acted.
async function renderCard() {
  render(<ToolSearchRuntimeCard />)
  await waitFor(() => expect(getToolCatalogMock).toHaveBeenCalled())
}

beforeEach(() => {
  saveMock.mockReset()
  mockSettings = {}
  getToolCatalogMock.mockReset()
  getToolCatalogMock.mockResolvedValue([
    { id: "m1", name: "my-mcp", source: "mcp", description: "", enabled: true },
    { id: "b1", name: "read_file", source: "builtin", description: "", enabled: true },
  ])
})

describe("ToolSearchRuntimeCard", () => {
  it("renders the enable toggle and hides editors when disabled", async () => {
    await renderCard()
    expect(screen.getByText("enableLabel")).toBeInTheDocument()
    expect(screen.queryByTestId("tool-search-servers")).not.toBeInTheDocument()
  })

  it("toggling enable persists { enabled: true }", async () => {
    await renderCard()
    fireEvent.click(screen.getByRole("switch"))
    expect(saveMock).toHaveBeenCalledWith({ toolSearchRuntime: { enabled: true } })
  })

  it("shows both list editors when enabled", async () => {
    mockSettings = { toolSearchRuntime: { enabled: true } }
    await renderCard()
    expect(screen.getByTestId("tool-search-servers")).toBeInTheDocument()
    expect(screen.getByTestId("tool-search-tools")).toBeInTheDocument()
  })

  it("adding a server persists the merged config", async () => {
    mockSettings = { toolSearchRuntime: { enabled: true } }
    await renderCard()
    const serversBlock = screen.getByTestId("tool-search-servers")
    const input = serversBlock.querySelector("input")!
    fireEvent.change(input, { target: { value: "cognia-tools" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(saveMock).toHaveBeenCalledWith({
      toolSearchRuntime: { enabled: true, alwaysLoadServers: ["cognia-tools"] },
    })
  })

  it("removing a pinned tool persists the reduced list", async () => {
    mockSettings = { toolSearchRuntime: { enabled: true, alwaysLoadTools: ["read_file"] } }
    await renderCard()
    // removeAria passthrough → "removeAria:read_file"
    fireEvent.click(screen.getByLabelText("removeAria:read_file"))
    expect(saveMock).toHaveBeenCalledWith({
      toolSearchRuntime: { enabled: true, alwaysLoadTools: [] },
    })
  })

  it("does not add duplicate or empty values", async () => {
    mockSettings = { toolSearchRuntime: { enabled: true, alwaysLoadServers: ["x"] } }
    await renderCard()
    const input = screen.getByTestId("tool-search-servers").querySelector("input")!
    fireEvent.change(input, { target: { value: "x" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("offers catalog server/tool names as datalist suggestions", async () => {
    mockSettings = { toolSearchRuntime: { enabled: true } }
    await renderCard()
    // Servers: builtin + plugin synthetic names + the MCP server name.
    await waitFor(() => {
      const opts = [
        ...screen.getByTestId("tool-search-servers").querySelectorAll("datalist option"),
      ].map((o) => o.getAttribute("value"))
      expect(opts).toEqual(
        expect.arrayContaining(["cognia-tools", "cognia-plugin-tools", "my-mcp"])
      )
    })
    // Tools: bare names from non-MCP sources only (no server names leak in).
    const toolOpts = [
      ...screen.getByTestId("tool-search-tools").querySelectorAll("datalist option"),
    ].map((o) => o.getAttribute("value"))
    expect(toolOpts).toEqual(["read_file"])
  })

  it("flags a pinned value that is absent from the catalog", async () => {
    mockSettings = {
      toolSearchRuntime: { enabled: true, alwaysLoadServers: ["my-mcp", "typoed-server"] },
    }
    await renderCard()
    // Known server → no warning; unknown server → exactly one warning marker.
    await waitFor(() => expect(screen.getByLabelText("unknownHint")).toBeInTheDocument())
    expect(screen.getAllByLabelText("unknownHint")).toHaveLength(1)
  })

  it("does not flag anything while the catalog is still empty", async () => {
    mockSettings = { toolSearchRuntime: { enabled: true, alwaysLoadServers: ["whatever"] } }
    // Synchronously after render the known sets are empty, so nothing is
    // flagged (avoids false positives during the catalog load).
    render(<ToolSearchRuntimeCard />)
    expect(screen.queryByLabelText("unknownHint")).not.toBeInTheDocument()
    // Flush the mount effect inside act so the async load doesn't warn.
    await waitFor(() => expect(getToolCatalogMock).toHaveBeenCalled())
  })
})
