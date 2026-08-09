/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@cognia/logging", () => ({ loggers: { mcp: { info: jest.fn(), error: jest.fn() } } }))

// Faithful useLiveQuery stand-in: returns undefined on first render, resolves
// the querier async, and retains the stale previous value across dep changes —
// exactly the real dexie-react-hooks semantics the editor-host race depends on.
jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    useLiveQuery: (querier: () => unknown, deps: unknown[]) => {
      const [value, setValue] = React.useState<unknown>(undefined)
      React.useEffect(() => {
        let active = true
        Promise.resolve(querier()).then((v) => {
          if (active) setValue(v)
        })
        return () => {
          active = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})

jest.mock("@/lib/db/mcp-servers", () => ({
  createMcpServer: jest.fn().mockResolvedValue(undefined),
  updateMcpServer: jest.fn().mockResolvedValue(undefined),
  deleteMcpServer: jest.fn().mockResolvedValue(undefined),
  getMcpServer: jest.fn().mockResolvedValue(undefined),
  listMcpServers: jest.fn().mockResolvedValue([]),
}))
jest.mock("@/lib/claude/mcp-presets", () => ({ applyPresetFields: jest.fn(() => ({})) }))
jest.mock("./server-seed", () => ({ blankServerSeed: jest.fn().mockResolvedValue({}) }))

jest.mock("./mcp-my-servers-tab", () => ({
  McpMyServersTab: () => <div data-testid="t-servers" />,
}))
jest.mock("./mcp-preset-grid", () => ({
  McpPresetGrid: ({
    existingNames,
    onPresetSelected,
  }: {
    existingNames: string[]
    onPresetSelected: (p: unknown, v: Record<string, string>) => void
  }) => (
    <div data-testid="t-presets" data-existing={JSON.stringify(existingNames)}>
      <button onClick={() => onPresetSelected({ id: "custom" }, {})}>pick-custom</button>
      <button
        onClick={() =>
          onPresetSelected(
            {
              id: "github",
              name: "GitHub",
              transport: "stdio",
              defaultDisallowedTools: ["dangerous_tool"],
            },
            {}
          )
        }
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
jest.mock("./mcp-server-editor", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    McpServerEditor: ({
      initial,
      onSave,
      onCancel,
    }: {
      initial: { config: Record<string, unknown> }
      onSave: (d: unknown) => void
      onCancel: () => void
    }) => {
      // Mirror the real editor: fields are seeded from `initial` ONCE at mount.
      const [seeded] = React.useState(initial)
      return (
        <div data-testid="server-editor" data-seeded={JSON.stringify(seeded.config)}>
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
      )
    },
  }
})

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpPanel } from "./mcp-panel"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import {
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
} from "@/lib/db/mcp-servers"

beforeEach(() => {
  ;(createMcpServer as jest.Mock).mockClear()
  ;(updateMcpServer as jest.Mock).mockClear()
  ;(deleteMcpServer as jest.Mock).mockClear()
  ;(getMcpServer as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(listMcpServers as jest.Mock).mockReset().mockResolvedValue([])
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
      disallowedTools: ["dangerous_tool"],
    })
    await waitFor(() => expect(useMcpPanelStore.getState().activeTab).toBe("my-servers"))
  })

  it("feeds the existing server names (lowercased) into the preset grid", async () => {
    ;(listMcpServers as jest.Mock).mockResolvedValue([{ name: "GitHub" }, { name: "Slack" }])
    useMcpPanelStore.setState({ activeTab: "presets" })
    render(<McpPanel />)
    const grid = await screen.findByTestId("t-presets")
    await waitFor(() =>
      expect(JSON.parse(grid.dataset.existing ?? "[]")).toEqual(["github", "slack"])
    )
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
    ;(getMcpServer as jest.Mock).mockResolvedValue({
      id: "srv1",
      name: "old",
      transport: "stdio",
      config: { command: "c" },
      enabled: true,
      appsEnabled: {},
    })
    useMcpPanelStore.setState({ editorTarget: { mode: "edit", serverId: "srv1" } })
    render(<McpPanel />)
    fireEvent.click(await screen.findByText("do-save"))
    await waitFor(() =>
      expect(updateMcpServer as jest.Mock).toHaveBeenCalledWith("srv1", expect.any(Object))
    )
  })

  it("does not mount the editor before the edited row resolves", () => {
    // Never-resolving load: the editor must stay unmounted instead of seeding blanks.
    ;(getMcpServer as jest.Mock).mockReturnValue(new Promise(() => {}))
    useMcpPanelStore.setState({ editorTarget: { mode: "edit", serverId: "srv1" } })
    render(<McpPanel />)
    expect(screen.queryByTestId("server-editor")).not.toBeInTheDocument()
  })

  it("seeds the editor with the loaded row config in edit mode", async () => {
    ;(getMcpServer as jest.Mock).mockResolvedValue({
      id: "srv1",
      name: "fs",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "pkg"] },
      enabled: true,
      appsEnabled: {},
    })
    useMcpPanelStore.setState({ editorTarget: { mode: "edit", serverId: "srv1" } })
    render(<McpPanel />)
    const editor = await screen.findByTestId("server-editor")
    expect(JSON.parse(editor.dataset.seeded ?? "{}")).toEqual({
      command: "npx",
      args: ["-y", "pkg"],
    })
  })

  it("re-seeds from the new row (not the stale one) when switching edited servers", async () => {
    const rows: Record<string, unknown> = {
      srv1: { id: "srv1", name: "a", transport: "stdio", config: { command: "aaa" } },
      srv2: { id: "srv2", name: "b", transport: "stdio", config: { command: "bbb" } },
    }
    ;(getMcpServer as jest.Mock).mockImplementation((id: string) => Promise.resolve(rows[id]))
    useMcpPanelStore.setState({ editorTarget: { mode: "edit", serverId: "srv1" } })
    render(<McpPanel />)
    await screen.findByTestId("server-editor")

    act(() => {
      useMcpPanelStore.setState({ editorTarget: { mode: "edit", serverId: "srv2" } })
    })
    await waitFor(() => {
      const editor = screen.getByTestId("server-editor")
      expect(JSON.parse(editor.dataset.seeded ?? "{}")).toEqual({ command: "bbb" })
    })
  })

  it("deletes a server when the delete dialog confirms", async () => {
    useMcpPanelStore.setState({ deleteTarget: { serverId: "a", name: "alpha" } })
    render(<McpPanel />)
    fireEvent.click(screen.getByText("confirm"))
    await waitFor(() => expect(deleteMcpServer as jest.Mock).toHaveBeenCalledWith("a"))
  })
})
