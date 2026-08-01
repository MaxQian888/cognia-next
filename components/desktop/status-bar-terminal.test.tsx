/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { SessionInfo } from "@/lib/terminal/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const transport = { canSpawn: true }
jest.mock("@/hooks/terminal/use-terminal-transport", () => ({
  useTerminalTransport: () => ({
    kind: transport.canSpawn ? "tauri-channel" : "unsupported",
    canSpawn: transport.canSpawn,
    isLocalPty: transport.canSpawn,
  }),
}))

import { StatusBarTerminal } from "./status-bar-terminal"

function info(id: string): SessionInfo {
  return { id, projectId: "p", extensionId: null, origin: "local", shell: "/bin/bash" }
}

beforeEach(() => {
  useTerminalStore.getState().reset()
  transport.canSpawn = true
})

describe("StatusBarTerminal", () => {
  it("renders nothing when there is neither a session nor a way to make one", () => {
    transport.canSpawn = false
    render(<StatusBarTerminal />)
    expect(screen.queryByTestId("status-terminal")).toBeNull()
  })

  it("still renders with no sessions when a spawn is possible", () => {
    render(<StatusBarTerminal />)
    expect(screen.getByTestId("status-terminal")).toHaveTextContent("terminal:0")
  })

  it("counts the open sessions", () => {
    useTerminalStore.getState().registerSession(info("a"))
    useTerminalStore.getState().registerSession(info("b"))
    render(<StatusBarTerminal />)
    expect(screen.getByTestId("status-terminal")).toHaveTextContent("terminal:2")
  })

  it("flags a running command", () => {
    useTerminalStore.getState().registerSession(info("a"))
    render(<StatusBarTerminal />)
    expect(screen.getByTestId("status-terminal")).toHaveAttribute("data-running", "false")

    act(() => {
      useTerminalStore.getState().setSessionStatus("a", "running")
    })
    expect(screen.getByTestId("status-terminal")).toHaveAttribute("data-running", "true")
  })

  it("toggles the dock and reflects its state", () => {
    render(<StatusBarTerminal />)
    const button = screen.getByTestId("status-terminal")
    expect(button).toHaveAttribute("aria-pressed", "false")

    fireEvent.click(button)
    expect(useTerminalStore.getState().panelOpen).toBe(true)
    expect(screen.getByTestId("status-terminal")).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(screen.getByTestId("status-terminal"))
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })

  it("still lists sessions on a shell that can no longer spawn", () => {
    // Sessions can outlive the ability to create new ones (a remote host that
    // dropped); reporting them is still useful.
    useTerminalStore.getState().registerSession(info("a"))
    transport.canSpawn = false
    render(<StatusBarTerminal />)
    expect(screen.getByTestId("status-terminal")).toHaveTextContent("terminal:1")
  })
})
