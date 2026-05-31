/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/logging", () => ({ loggers: { mcp: { info: jest.fn(), error: jest.fn() } } }))

let mockEditTarget: unknown = undefined
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockEditTarget }))

jest.mock("@/lib/db/mcp-servers", () => ({
  createMcpServer: jest.fn().mockResolvedValue(undefined),
  updateMcpServer: jest.fn().mockResolvedValue(undefined),
  deleteMcpServer: jest.fn().mockResolvedValue(undefined),
  getMcpServer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/claude/mcp-presets", () => ({ applyPresetFields: jest.fn(() => ({})) }))
jest.mock("./server-seed", () => ({ blankServerSeed: jest.fn().mockResolvedValue({}) }))

jest.mock("./mcp-my-servers-tab", () => ({
  McpMyServersTab: () => <div data-testid="t-servers" />,
}))
jest.mock("./mcp-preset-grid", () => ({
  McpPresetGrid: ({
    onPresetSelected,
  }: {
    onPresetSelected: (p: unknown, v: Record<string, string>) => void
  }) => (
    <div data-testid="t-presets">
      <button onClick={() => onPresetSelected({ id: "custom" }, {})}>pick-custom</button>
      <button
        onClick={() => onPresetSelected({ id: "github", name: "GitHub", transport: "stdio" }, {})}
      >
        pick-real
      </button>
    </div>
  ),
}))
jest.mock("./mcp-health-tab", () => ({ McpHealthTab: () => <div data-testid="t-health" /> }))
jest.mock("../mcp-agent-status-bar", () => ({
  McpAgentStatusBar: () => <div data-testid="t-agents" />,
}))
jest.mock("../mcp-drift-banner", () => ({ McpDriftBanner: () => <div /> }))
jest.mock("@/components/settings/common/related-sections-strip", () => ({
  RelatedSectionsStrip: () => <div />,
  CLAUDE_CODE_RELATED: [],
}))
jest.mock("./mcp-server-editor", () => ({
  McpServerEditor: ({
    onSave,
    onCancel,
  }: {
    onSave: (d: unknown) => void
    onCancel: () => void
  }) => (
    <div data-testid="server-editor">
      <button
        onClick={() =>
          onSave({
            name: "new",
            transport: "stdio",
            config: { command: "c" },
            enabled: true,
            appsEnabled: {},
          })
        }
      >
        do-save
      </button>
      <button onClick={onCancel}>do-cancel</button>
    </div>
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpPanel } from "./mcp-panel"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { createMcpServer, updateMcpServer, deleteMcpServer } from "@/lib/db/mcp-servers"

beforeEach(() => {
  mockEditTarget = undefined
  ;(createMcpServer as jest.Mock).mockClear()
  ;(updateMcpServer as jest.Mock).mockClear()
  ;(deleteMcpServer as jest.Mock).mockClear()
  useMcpPanelStore.setState({
    activeTab: "my-servers",
    editorTarget: null,
    deleteTarget: null,
    search: "",
  })
})

describe("McpPanel", () => {
  it("renders the four tabs and the My Servers tab by default", () => {
    render(<McpPanel />)
    expect(screen.getByText("myServers")).toBeInTheDocument()
    expect(screen.getByText("presets")).toBeInTheDocument()
    expect(screen.getByText("agents")).toBeInTheDocument()
    expect(screen.getByText("health")).toBeInTheDocument()
    expect(screen.getByTestId("t-servers")).toBeInTheDocument()
  })

  it("shows the search box only on the My Servers tab", () => {
    render(<McpPanel />)
    expect(screen.getByPlaceholderText("searchPlaceholder")).toBeInTheDocument()
    fireEvent.click(screen.getByText("presets"))
    expect(screen.queryByPlaceholderText("searchPlaceholder")).not.toBeInTheDocument()
    expect(screen.getByTestId("t-presets")).toBeInTheDocument()
  })

  it("switches to the health tab", () => {
    render(<McpPanel />)
    fireEvent.click(screen.getByText("health"))
    expect(screen.getByTestId("t-health")).toBeInTheDocument()
  })

  it("opens the editor sheet when an editor target is set", () => {
    useMcpPanelStore.setState({ editorTarget: { mode: "create" } })
    render(<McpPanel />)
    expect(screen.getByTestId("server-editor")).toBeInTheDocument()
  })

  it("opens the delete dialog when a delete target is set", () => {
    useMcpPanelStore.setState({ deleteTarget: { serverId: "a", name: "alpha" } })
    render(<McpPanel />)
    expect(screen.getByText('body:{"name":"alpha"}')).toBeInTheDocument()
  })

  it("creates a server from a real preset and returns to My Servers", async () => {
    useMcpPanelStore.setState({ activeTab: "presets" })
    render(<McpPanel />)
    fireEvent.click(screen.getByText("pick-real"))
    await waitFor(() => expect(createMcpServer as jest.Mock).toHaveBeenCalled())
    expect((createMcpServer as jest.Mock).mock.calls[0][0]).toMatchObject({
      name: "github",
      transport: "stdio",
    })
    await waitFor(() => expect(useMcpPanelStore.getState().activeTab).toBe("my-servers"))
  })

  it("opens a seeded create editor for the custom preset", async () => {
    useMcpPanelStore.setState({ activeTab: "presets" })
    render(<McpPanel />)
    fireEvent.click(screen.getByText("pick-custom"))
    await waitFor(() =>
      expect(useMcpPanelStore.getState().editorTarget).toMatchObject({ mode: "create" })
    )
    expect(createMcpServer as jest.Mock).not.toHaveBeenCalled()
  })

  it("creates a server when the editor host saves in create mode", async () => {
    useMcpPanelStore.setState({ editorTarget: { mode: "create" } })
    render(<McpPanel />)
    fireEvent.click(screen.getByText("do-save"))
    await waitFor(() => expect(createMcpServer as jest.Mock).toHaveBeenCalled())
  })

  it("updates a server when the editor host saves in edit mode", async () => {
    mockEditTarget = {
      id: "srv1",
      name: "old",
      transport: "stdio",
      config: { command: "c" },
      enabled: true,
      appsEnabled: {},
    }
    useMcpPanelStore.setState({ editorTarget: { mode: "edit", serverId: "srv1" } })
    render(<McpPanel />)
    fireEvent.click(screen.getByText("do-save"))
    await waitFor(() =>
      expect(updateMcpServer as jest.Mock).toHaveBeenCalledWith("srv1", expect.any(Object))
    )
  })

  it("deletes a server when the delete dialog confirms", async () => {
    useMcpPanelStore.setState({ deleteTarget: { serverId: "a", name: "alpha" } })
    render(<McpPanel />)
    fireEvent.click(screen.getByText("confirm"))
    await waitFor(() => expect(deleteMcpServer as jest.Mock).toHaveBeenCalledWith("a"))
  })
})
