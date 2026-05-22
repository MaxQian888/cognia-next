/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { TerminalToolPart } from "./terminal-tool-part"

jest.mock("@/components/ai-elements/tool", () => ({
  Tool: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tool-wrapper">{children}</div>
  ),
  ToolBody: () => <div data-testid="tool-body" />,
  ToolHeader: ({ state }: { state: string }) => (
    <div data-testid="tool-header" data-state={state} />
  ),
  ToolContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToolInput: ({ input }: { input: unknown }) => (
    <div data-testid="tool-input">{JSON.stringify(input)}</div>
  ),
}))

jest.mock("@/components/ai-elements/terminal", () => ({
  Terminal: ({
    output,
    isStreaming,
    children,
  }: {
    output?: string
    isStreaming?: boolean
    children?: React.ReactNode
  }) => (
    <div
      data-testid="terminal"
      data-streaming={isStreaming ? "true" : "false"}
      data-output={output ?? ""}
    >
      {children}
    </div>
  ),
  TerminalHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="terminal-header">{children}</div>
  ),
  TerminalStatus: ({ children, status }: { children: React.ReactNode; status?: string }) => (
    <span data-testid="terminal-status" data-status={status}>
      {children}
    </span>
  ),
}))

// Stub the dock picker + run helper so terminal-tool-part stays in
// isolation. The full pickers have their own dedicated tests.
const mockRunInDock = jest.fn(async () => ({
  kind: "ok" as const,
  sessionId: "s",
  exitCode: 0,
  output: "",
}))
jest.mock("@/lib/terminal/run-in-dock", () => ({
  runInDockTab: (...args: unknown[]) => mockRunInDock(...args),
}))
jest.mock("@/components/chat/terminal-tab-picker", () => ({
  TerminalTabPicker: ({
    children,
    onPick,
  }: {
    children: React.ReactNode
    onPick: (c: { kind: "new" }) => void
  }) => (
    <div data-testid="terminal-tab-picker-stub" onClick={() => onPick({ kind: "new" })}>
      {children}
    </div>
  ),
}))

// Force chat store to expose an active session id so the Run-in-dock
// button stays enabled.
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: { activeSessionId: string }) => unknown) =>
    selector({ activeSessionId: "chat-1" }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { projects: never[]; activeProjectId: null }) => unknown) =>
    selector({ projects: [], activeProjectId: null }),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: { terminal: object } }) => unknown) =>
    selector({ settings: { terminal: {} } }),
}))

const bashPart = (state: ToolUIPart["state"], extra: Partial<ToolUIPart> = {}): ToolUIPart =>
  ({
    type: "tool-Bash",
    toolCallId: "call-1",
    state,
    input: { command: "ls -la" },
    ...extra,
  }) as unknown as ToolUIPart

describe("TerminalToolPart", () => {
  it("renders Terminal view while the call is running", () => {
    render(<TerminalToolPart part={bashPart("input-available")} />)

    expect(screen.getByTestId("terminal-tool-running")).toBeInTheDocument()
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-streaming", "true")
    expect(screen.getByTestId("terminal-status")).toHaveAttribute("data-status", "running")
    expect(screen.queryByTestId("tool-body")).toBeNull()
  })

  it("forwards the command through ToolInput while running", () => {
    render(<TerminalToolPart part={bashPart("input-available")} />)
    expect(screen.getByTestId("tool-input").textContent).toContain("ls -la")
  })

  it("surfaces incremental stdout / stderr on the Terminal output prop", () => {
    render(
      <TerminalToolPart
        part={bashPart("input-available", {
          output: { stdout: "hello", stderr: "warn" } as unknown,
        })}
      />
    )
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-output", "hello\nwarn")
  })

  it("falls back to ToolBody once the call completes", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-available", { output: "done" } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.queryByTestId("terminal-tool-running")).toBeNull()
    expect(screen.getByTestId("tool-body")).toBeInTheDocument()
  })

  it("falls back to ToolBody on error so ErrorTraceDetails kicks in upstream", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-error", { errorText: "boom" } as unknown as ToolUIPart)}
      />
    )
    expect(screen.queryByTestId("terminal-tool-running")).toBeNull()
    expect(screen.getByTestId("tool-body")).toBeInTheDocument()
  })

  it("renders the Run-in-dock button when a command is present and chatSessionId is known", () => {
    render(<TerminalToolPart part={bashPart("input-available")} />)
    expect(screen.getByTestId("terminal-tool-part-run-in-dock")).toBeInTheDocument()
  })

  it("clicking Run-in-dock through the picker forwards the command via runInDockTab", () => {
    render(<TerminalToolPart part={bashPart("input-available")} />)
    mockRunInDock.mockClear()
    // The picker stub fires onPick({kind:'new'}) on its container click.
    screen.getByTestId("terminal-tab-picker-stub").click()
    expect(mockRunInDock).toHaveBeenCalled()
    const call = mockRunInDock.mock.calls[0][0] as {
      chatSessionId: string
      command: string
    }
    expect(call.chatSessionId).toBe("chat-1")
    expect(call.command).toBe("ls -la")
  })
})
