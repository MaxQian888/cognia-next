/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const sessionWrite = jest.fn(async () => undefined)
jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: jest.fn(() => ({ write: sessionWrite })),
}))

import { TerminalHistoryPanel } from "./terminal-history-panel"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { SessionInfo } from "@/lib/terminal/types"

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s-1",
    projectId: "proj-a",
    extensionId: null,
    origin: "local",
    shell: "/bin/bash",
    ...overrides,
  }
}

beforeEach(() => {
  useTerminalStore.getState().reset()
  sessionWrite.mockClear()
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn(async () => undefined) },
  })
})

describe("TerminalHistoryPanel", () => {
  it("renders a play button when closed", () => {
    useTerminalStore.getState().registerSession(info())
    render(<TerminalHistoryPanel sessionId="s-1" />)
    expect(screen.getByTestId("terminal-history-open")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-history-panel")).toBeNull()
  })

  it("opens the panel when toggle is clicked", () => {
    useTerminalStore.getState().registerSession(info())
    render(<TerminalHistoryPanel sessionId="s-1" />)
    fireEvent.click(screen.getByTestId("terminal-history-open"))
    expect(screen.getByTestId("terminal-history-panel")).toBeInTheDocument()
  })

  it("shows empty state when no commands", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    render(<TerminalHistoryPanel sessionId="s-1" />)
    expect(screen.getByTestId("terminal-history-empty")).toBeInTheDocument()
  })

  it("lists commands newest-first with exit dots", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    useTerminalStore.getState().pushCommand("s-1", { cmd: "ls", exitCode: 0, endedAt: 1000 })
    useTerminalStore.getState().pushCommand("s-1", { cmd: "fail", exitCode: 1, endedAt: 2000 })
    render(<TerminalHistoryPanel sessionId="s-1" />)
    const rows = screen.getAllByTestId("terminal-history-row")
    expect(rows).toHaveLength(2)
    // First rendered row is the newest (reversed).
    expect(rows[0].textContent).toContain("fail")
    expect(rows[1].textContent).toContain("ls")
  })

  it("Copy button writes the command to navigator.clipboard", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    useTerminalStore.getState().pushCommand("s-1", { cmd: "pwd", exitCode: 0, endedAt: 1 })
    render(<TerminalHistoryPanel sessionId="s-1" />)
    fireEvent.click(screen.getByTestId("terminal-history-copy"))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("pwd")
  })

  it("Re-run button calls session.write with the command + CR", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    useTerminalStore.getState().pushCommand("s-1", { cmd: "echo hi", exitCode: 0, endedAt: 1 })
    render(<TerminalHistoryPanel sessionId="s-1" />)
    fireEvent.click(screen.getByTestId("terminal-history-rerun"))
    expect(sessionWrite).toHaveBeenCalledWith("echo hi\r")
  })

  it("shift-click on a row triggers re-run instead of copy", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    useTerminalStore.getState().pushCommand("s-1", { cmd: "make build", exitCode: 0, endedAt: 1 })
    render(<TerminalHistoryPanel sessionId="s-1" />)
    const rowText = screen.getByText("make build")
    fireEvent.click(rowText, { shiftKey: true })
    expect(sessionWrite).toHaveBeenCalledWith("make build\r")
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it("close button collapses the panel", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    render(<TerminalHistoryPanel sessionId="s-1" />)
    fireEvent.click(screen.getByTestId("terminal-history-close"))
    expect(useTerminalStore.getState().sessions["s-1"]?.historyOpen).toBe(false)
  })

  it("hides the locate button for user-spawned sessions", () => {
    useTerminalStore.getState().registerSession(info())
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    render(<TerminalHistoryPanel sessionId="s-1" onLocateInChat={jest.fn()} />)
    expect(screen.queryByTestId("terminal-history-locate")).toBeNull()
  })

  it("shows the locate button for agent sessions and fires onLocateInChat", () => {
    useTerminalStore.getState().registerSession(info(), {
      agentSpawner: "chat-9",
      agentSpawnerMessageId: "msg-4",
    })
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    const onLocateInChat = jest.fn()
    render(<TerminalHistoryPanel sessionId="s-1" onLocateInChat={onLocateInChat} />)
    fireEvent.click(screen.getByTestId("terminal-history-locate"))
    // The spawning message travels with the session id, so the chat can land on
    // the turn that opened this tab rather than at the end of the thread.
    expect(onLocateInChat).toHaveBeenCalledWith("chat-9", "msg-4")
  })

  it("still locates a tab spawned before the message id was recorded", () => {
    useTerminalStore.getState().registerSession(info(), { agentSpawner: "chat-9" })
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    const onLocateInChat = jest.fn()
    render(<TerminalHistoryPanel sessionId="s-1" onLocateInChat={onLocateInChat} />)
    fireEvent.click(screen.getByTestId("terminal-history-locate"))
    expect(onLocateInChat).toHaveBeenCalledWith("chat-9", null)
  })
})
