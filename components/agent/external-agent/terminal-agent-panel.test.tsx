/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/externalAgent.json"
import { TerminalAgentPanel } from "./terminal-agent-panel"
import {
  launchTerminalAgent,
  openAgentTerminal,
  stopTerminalAgent,
} from "@/lib/terminal/agent-session"
import { useTerminalStore, type TerminalSessionRow } from "@/stores/terminal/terminal-store"
import { useTerminalTransport } from "@/hooks/terminal/use-terminal-transport"
import { openUrl } from "@/lib/native/opener"
import { terminalAgentProfileId } from "@/lib/agent-ecosystem/terminal-agents"

jest.mock("@/stores/project/project-store", () => {
  const state = {
    activeProjectId: "current",
    projects: [
      { id: "current", name: "Current project", roots: [{ path: "/current", isPrimary: true }] },
      { id: "other", name: "Other project", roots: [{ path: "/other", isPrimary: true }] },
    ],
    setActiveProject: jest.fn(),
  }
  return {
    useProjectStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state }
    ),
  }
})
jest.mock("@/hooks/terminal/use-terminal-transport", () => ({
  useTerminalTransport: jest.fn(() => ({
    canSpawn: true,
    kind: "tauri-channel",
    isLocalPty: true,
  })),
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn(async () => {}) }))
jest.mock("@/lib/terminal/agent-session", () => ({
  ...jest.requireActual("@/lib/terminal/agent-session"),
  launchTerminalAgent: jest.fn(),
  openAgentTerminal: jest.fn(),
  stopTerminalAgent: jest.fn(),
}))
jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: (id: string) =>
    id === "running" ? { isExited: false, info: { alive: true } } : undefined,
  subscribeLiveSessions: () => () => {},
}))
jest.mock("@/components/ui/native-select", () => ({
  NativeSelect: (props: React.ComponentProps<"select">) => <select {...props} />,
}))

function row(status: "running" | "exited" = "running"): TerminalSessionRow {
  return {
    id: "running",
    profileId: terminalAgentProfileId("freebuff"),
    projectId: "current",
    status,
    cwd: "/current",
    createdAt: 1,
  } as TerminalSessionRow
}

function mount(onOpenedInTerminal = jest.fn()) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={{ externalAgent: messages }} timeZone="UTC">
      <TerminalAgentPanel onOpenedInTerminal={onOpenedInTerminal} />
    </NextIntlClientProvider>
  )
  return { ...view, onOpenedInTerminal }
}

async function expand() {
  await userEvent.click(screen.getByRole("button", { name: /Terminal agents/ }))
}

beforeEach(() => {
  jest.clearAllMocks()
  useTerminalStore.setState({ sessions: {}, panelOpen: false })
  jest
    .mocked(useTerminalTransport)
    .mockReturnValue({ canSpawn: true, kind: "tauri-channel", isLocalPty: true })
  jest.mocked(launchTerminalAgent).mockResolvedValue({ kind: "launched", sessionId: "started" })
  jest.mocked(openAgentTerminal).mockReturnValue({ kind: "opened", sessionId: "running" })
  jest.mocked(stopTerminalAgent).mockResolvedValue({ kind: "stopped" })
})

describe("native terminal agent panel", () => {
  it("requires a click to launch and explains native authorization limits", async () => {
    mount()
    expect(launchTerminalAgent).not.toHaveBeenCalled()
    await expand()
    expect(screen.getByText(/Cognia chat approvals, prompt filtering/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Launch Freebuff" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Launch ZCode" })).toBeEnabled()
  })

  it("launches in an explicitly selected host workspace and hands interaction to the terminal", async () => {
    const { onOpenedInTerminal } = mount()
    await expand()
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "other")
    expect(
      screen.getByRole("textbox", { name: "Working directory on the terminal host" })
    ).toHaveValue("/other")
    fireEvent.change(
      screen.getByRole("textbox", { name: "Working directory on the terminal host" }),
      { target: { value: "/other/project with spaces;literal" } }
    )
    await userEvent.click(screen.getByRole("button", { name: "Launch Freebuff" }))
    await waitFor(() => expect(onOpenedInTerminal).toHaveBeenCalledTimes(1))
    expect(launchTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "freebuff",
        projectId: "other",
        cwd: "/other/project with spaces;literal",
        host: expect.objectContaining({ getStore: expect.any(Function) }),
      })
    )
  })

  it("keeps setup available but disables launch without a process host", async () => {
    jest
      .mocked(useTerminalTransport)
      .mockReturnValue({ canSpawn: false, kind: "unsupported", isLocalPty: false })
    mount()
    await expand()
    expect(screen.getByRole("status")).toHaveTextContent("desktop or paired terminal host")
    expect(screen.getByRole("button", { name: "Launch Freebuff" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Set up Freebuff" }))
    expect(openUrl).toHaveBeenCalledWith("https://freebuff.com/cli")
  })

  it("reopens an existing process and projects native exit state without a new launch", async () => {
    useTerminalStore.setState({ sessions: { running: row() } })
    const { onOpenedInTerminal } = mount()
    await expand()
    const freebuff = screen.getByRole("listitem", { name: "Freebuff" })
    expect(within(freebuff).getByText("Process running")).toBeInTheDocument()
    await userEvent.click(within(freebuff).getByRole("button", { name: "Open Freebuff terminal" }))
    expect(openAgentTerminal).toHaveBeenCalledWith("freebuff", expect.anything())
    expect(onOpenedInTerminal).toHaveBeenCalledTimes(1)
    act(() => useTerminalStore.setState({ sessions: { running: row("exited") } }))
    expect(within(freebuff).getByText("Exited")).toBeInTheDocument()
    expect(within(freebuff).getByRole("button", { name: "Restart Freebuff" })).toBeEnabled()
    expect(launchTerminalAgent).not.toHaveBeenCalled()
  })

  it("retains failed-stop feedback and offers retryable host-profile cleanup", async () => {
    useTerminalStore.setState({ sessions: { running: row() } })
    jest.mocked(stopTerminalAgent).mockResolvedValueOnce({ kind: "error", code: "stop-failed" })
    mount()
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "Stop and close Freebuff" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("terminal is retained")
    expect(screen.getByRole("button", { name: "Open Freebuff terminal" })).toBeEnabled()
    jest.mocked(stopTerminalAgent).mockImplementationOnce(async () => {
      useTerminalStore.setState({ sessions: {} })
      return { kind: "error", code: "cleanup-failed" }
    })
    await userEvent.click(screen.getByRole("button", { name: "Stop and close Freebuff" }))
    expect(await screen.findByRole("button", { name: "Retry Freebuff cleanup" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "Retry Freebuff cleanup" }))
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(stopTerminalAgent).toHaveBeenCalledTimes(3)
  })

  it("does not dismiss the manager or claim a running process after launch denial", async () => {
    jest.mocked(launchTerminalAgent).mockResolvedValueOnce({ kind: "error", code: "spawn-denied" })
    const { onOpenedInTerminal } = mount()
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "Launch Freebuff" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("denied by host or plugin policy")
    expect(onOpenedInTerminal).not.toHaveBeenCalled()
    expect(screen.getAllByText("Not running")).toHaveLength(2)
  })

  it("can stop a pending launch and ignores that launch's late UI handoff", async () => {
    let finish!: (result: { kind: "launched"; sessionId: string }) => void
    jest.mocked(launchTerminalAgent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { onOpenedInTerminal } = mount()
    await expand()
    await userEvent.click(screen.getByRole("button", { name: "Launch Freebuff" }))
    await userEvent.click(screen.getByRole("button", { name: "Stop and close Freebuff" }))
    expect(stopTerminalAgent).toHaveBeenCalledWith("freebuff", expect.anything())
    await act(async () => finish({ kind: "launched", sessionId: "late" }))
    expect(onOpenedInTerminal).not.toHaveBeenCalled()
  })
})
