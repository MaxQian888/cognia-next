import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ToolCatalogBrowser } from "./tool-catalog-browser"
import type { ToolCatalogEntry } from "@/lib/tools/tool-catalog"

const save = jest.fn().mockResolvedValue(undefined)
let settingsState: { settings: unknown; save: typeof save }

const CATALOG: ToolCatalogEntry[] = [
  {
    id: "mcp__cognia-tools__git_status",
    name: "git_status",
    source: "builtin",
    description: "",
    enabled: true,
    riskLevel: "low",
  },
  {
    id: "mcp__cognia-tools__run_shell",
    name: "run_shell",
    source: "builtin",
    description: "",
    enabled: true,
    riskLevel: "high",
  },
  {
    id: "srv_1",
    name: "Playwright",
    source: "mcp",
    description: "MCP server (stdio)",
    ownerName: "Playwright",
    enabled: false,
  },
]

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && "count" in vars) return `${key}:${vars.count}`
    if (vars && "tool" in vars) return `${key}:${vars.tool}`
    return key
  },
}))

jest.mock("@/lib/tools/tool-catalog", () => {
  const actual = jest.requireActual("@/lib/tools/tool-catalog")
  return {
    ...actual,
    getToolCatalog: jest.fn(() => Promise.resolve(CATALOG)),
  }
})

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(settingsState),
}))

describe("ToolCatalogBrowser", () => {
  beforeEach(() => {
    save.mockClear()
    settingsState = { settings: { toolFilter: { mode: "all" } }, save }
  })

  it("renders the aggregated catalog after load", async () => {
    render(<ToolCatalogBrowser />)
    expect(await screen.findByText("git_status")).toBeInTheDocument()
    expect(screen.getByText("run_shell")).toBeInTheDocument()
    expect(screen.getByText("Playwright")).toBeInTheDocument()
  })

  it("marks a disabled source entry with the disabled badge", async () => {
    render(<ToolCatalogBrowser />)
    await screen.findByText("Playwright")
    expect(screen.getByText("disabled")).toBeInTheDocument()
  })

  it("filters results by the search query", async () => {
    render(<ToolCatalogBrowser />)
    await screen.findByText("git_status")
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), { target: { value: "git" } })
    await waitFor(() => {
      expect(screen.queryByText("run_shell")).not.toBeInTheDocument()
    })
    expect(screen.getByText("git_status")).toBeInTheDocument()
  })

  it("checkboxes are disabled when filter mode is 'all'", async () => {
    render(<ToolCatalogBrowser />)
    await screen.findByText("git_status")
    for (const cb of screen.getAllByRole("checkbox")) {
      expect(cb).toBeDisabled()
    }
  })

  it("persists the selected tool when filtering is active", async () => {
    settingsState = { settings: { toolFilter: { mode: "allow", tools: [] } }, save }
    render(<ToolCatalogBrowser />)
    await screen.findByText("git_status")
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({
        toolFilter: { mode: "allow", tools: ["mcp__cognia-tools__git_status"] },
      })
    })
  })

  it("routes an MCP-server selection into mcpServerIds, not tools", async () => {
    // resolveSendOptions filters MCP servers via toolFilter.mcpServerIds; writing
    // the server id into `tools` would make the selection inert at send time.
    settingsState = { settings: { toolFilter: { mode: "deny", tools: [] } }, save }
    render(<ToolCatalogBrowser />)
    await screen.findByText("Playwright")
    const mcpCheckbox = screen.getAllByRole("checkbox")[2] // the mcp-source row
    fireEvent.click(mcpCheckbox)
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({
        toolFilter: { mode: "deny", tools: [], mcpServerIds: ["srv_1"] },
      })
    })
  })

  it("counts both tool and MCP-server selections in the badge", async () => {
    settingsState = {
      settings: {
        toolFilter: {
          mode: "allow",
          tools: ["mcp__cognia-tools__git_status"],
          mcpServerIds: ["srv_1"],
        },
      },
      save,
    }
    render(<ToolCatalogBrowser />)
    await screen.findByText("git_status")
    expect(screen.getByText("selectedCount:2")).toBeInTheDocument()
  })
})
