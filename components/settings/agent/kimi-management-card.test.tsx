import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { KimiManagementCard } from "./kimi-management-card"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import en from "@/i18n/messages/en/kimiManagement.json"

const clipboard = jest.fn(async () => {})
const launch = jest.fn(async () => {})
const transport = jest.fn(() => "tauri-channel")
let mockConnection = "disconnected"
let mockOtherAgent: ExternalAgentConfig | null = null
let mockOtherConnection = "disconnected"
const mockStoreState = () => ({
  agents: mockOtherAgent ? { [mockOtherAgent.id]: mockOtherAgent } : {},
  getConnectionStatus: (id: string) =>
    id === mockOtherAgent?.id ? mockOtherConnection : mockConnection,
})
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(mockStoreState()),
    { getState: () => mockStoreState() }
  ),
}))
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (...args: unknown[]) => clipboard(...args),
}))
jest.mock("@/lib/terminal/run-in-dock", () => ({
  runInTerminalDock: (...args: unknown[]) => launch(...args),
}))
jest.mock("@/lib/terminal/pick-transport", () => ({ selectTerminalTransport: () => transport() }))
jest.mock("@/lib/terminal/shell-detect", () => ({ detectPlatform: () => "macos" }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    const value = key
      .split(".")
      .reduce((obj, part) => (obj as Record<string, unknown>)[part], en as unknown)
    return typeof value === "string"
      ? value.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? name)
      : key
  },
}))

const agent = {
  id: "kimi-agent",
  process: {
    command: "kimi",
    args: ["acp"],
    cwd: "/workspace",
    env: { KIMI_CODE_HOME: "/owned/state", KIMI_MODEL_API_KEY: "secret-key" },
  },
} as ExternalAgentConfig

describe("KimiManagementCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    transport.mockReturnValue("tauri-channel")
    mockConnection = "disconnected"
    mockOtherAgent = null
    mockOtherConnection = "disconnected"
  })

  it("offers reviewed installation and explicit package ownership guidance", async () => {
    render(<KimiManagementCard agent={agent} />)
    expect(screen.getByText(en.ownership)).toBeInTheDocument()
    expect(screen.getByText(en.quota)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Copy Install reviewed version command" }))
    await waitFor(() =>
      expect(clipboard).toHaveBeenCalledWith("npm install --global @moonshot-ai/kimi-code@2.1.1")
    )
    expect(launch).not.toHaveBeenCalled()
    expect(screen.queryByText(/secret-key/)).not.toBeInTheDocument()
  })

  it("opens native web with scoped state and without ACP arguments or unsafe host flags", async () => {
    render(<KimiManagementCard agent={agent} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal for Open native web management" })
    )
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith(
        "/bin/sh -c 'cd -- /workspace && env KIMI_CODE_HOME=/owned/state kimi web'",
        "/workspace",
        ""
      )
    )
    expect(launch.mock.calls.flat().join(" ")).not.toMatch(/secret-key|dangerous-bypass|--host|acp/)
  })

  it("does not launch native management on a remote host", () => {
    transport.mockReturnValue("ws")
    render(<KimiManagementCard agent={agent} />)
    expect(
      screen.getByRole("button", { name: "Open terminal for Open native web management" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Copy Open native web management command" })
    ).toBeEnabled()
  })

  it("exports only an explicit native session, with global diagnostic log excluded", async () => {
    render(<KimiManagementCard agent={agent} />)
    const copy = screen.getByRole("button", { name: en.copyExport })
    expect(copy).toBeDisabled()
    fireEvent.change(screen.getByLabelText(en.exportSession), { target: { value: "session-123" } })
    fireEvent.click(copy)
    await waitFor(() =>
      expect(clipboard).toHaveBeenCalledWith(
        "cd -- /workspace && env KIMI_CODE_HOME=/owned/state kimi export session-123 --no-include-global-log"
      )
    )
  })

  it("disables malformed state configuration and never falls back to a different account", () => {
    render(
      <KimiManagementCard
        agent={{ ...agent, process: { ...agent.process!, env: { KIMI_CODE_HOME: " " } } }}
      />
    )
    expect(
      screen.getByRole("button", { name: "Copy Open native web management command" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Open terminal for Open native web management" })
    ).toBeDisabled()
  })

  it("requires confirmation for package install and cancellation never launches", () => {
    render(<KimiManagementCard agent={agent} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal for Install reviewed version" })
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "npm install --global @moonshot-ai/kimi-code@2.1.1"
    )
    expect(launch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(launch).not.toHaveBeenCalled()
  })

  it("launches exactly the confirmed pinned install command", async () => {
    render(<KimiManagementCard agent={agent} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal for Install reviewed version" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Run reviewed command" }))
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith(
        "/bin/sh -c 'npm install --global @moonshot-ai/kimi-code@2.1.1'",
        "/workspace",
        ""
      )
    )
  })

  it("blocks package mutation while the selected runtime is connected", () => {
    mockConnection = "connected"
    render(<KimiManagementCard agent={agent} />)
    expect(
      screen.getByRole("button", { name: "Open terminal for Install reviewed version" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Open terminal for Uninstall npm installation" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Copy Install reviewed version command" })
    ).toBeEnabled()
  })

  it.each(["connected", "connecting", "reconnecting"])(
    "blocks shared npm package mutation when another Kimi agent is %s",
    (status) => {
      mockOtherAgent = { ...agent, id: "other-kimi", metadata: { preset: "kimi" } }
      mockOtherConnection = status
      render(<KimiManagementCard agent={agent} />)
      expect(
        screen.getByRole("button", { name: "Open terminal for Install reviewed version" })
      ).toBeDisabled()
      expect(
        screen.getByRole("button", { name: "Open terminal for Uninstall npm installation" })
      ).toBeDisabled()
      expect(launch).not.toHaveBeenCalled()
    }
  )

  it("rechecks connection state at confirmation even before React rerenders", () => {
    render(<KimiManagementCard agent={agent} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal for Uninstall npm installation" })
    )
    mockConnection = "connected"
    fireEvent.click(screen.getByRole("button", { name: "Run reviewed command" }))
    expect(launch).not.toHaveBeenCalled()
  })

  it("discards pending confirmation when switching agents", () => {
    const view = render(<KimiManagementCard agent={agent} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal for Uninstall npm installation" })
    )
    view.rerender(<KimiManagementCard agent={{ ...agent, id: "other-agent" }} />)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(launch).not.toHaveBeenCalled()
  })

  it.each([
    ["Restore reviewed version", "/bin/sh -c 'npm install --global @moonshot-ai/kimi-code@2.1.1'"],
    [
      "Check native upgrade",
      "/bin/sh -c 'cd -- /workspace && env KIMI_CODE_HOME=/owned/state kimi upgrade'",
    ],
    ["Uninstall npm installation", "/bin/sh -c 'npm uninstall --global @moonshot-ai/kimi-code'"],
  ])("launches %s only after reviewing its exact command", async (action, command) => {
    render(<KimiManagementCard agent={agent} />)
    fireEvent.click(screen.getByRole("button", { name: `Open terminal for ${action}` }))
    expect(launch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Run reviewed command" }))
    await waitFor(() => expect(launch).toHaveBeenCalledWith(command, "/workspace", ""))
  })

  it("refuses changed configuration instead of executing an unreviewed upgrade command", async () => {
    const view = render(<KimiManagementCard agent={agent} />)
    fireEvent.click(screen.getByRole("button", { name: "Open terminal for Check native upgrade" }))
    view.rerender(
      <KimiManagementCard
        agent={{ ...agent, process: { ...agent.process!, cwd: "/different/workspace" } }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Run reviewed command" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(launch).not.toHaveBeenCalled()
  })
})
