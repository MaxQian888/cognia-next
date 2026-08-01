/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { TerminalToolPart } from "./terminal-tool-part"

jest.mock("@/components/ai-elements/tool", () => ({
  Tool: ({ children, defaultOpen }: { children: React.ReactNode; defaultOpen?: boolean }) => (
    <div data-testid="tool-wrapper" data-default-open={String(defaultOpen)}>
      {children}
    </div>
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
const mockRunInDock = jest.fn(async (..._args: unknown[]) => ({
  kind: "ok" as const,
  sessionId: "s",
  exitCode: 0,
  output: "",
}))
jest.mock("@/lib/terminal/run-in-dock", () => ({
  runInDockTab: (...args: unknown[]) => mockRunInDock(...args),
}))
// Which choice the picker stub reports on click. Mutable so a test can exercise
// the existing-tab branch as well as the new-tab one.
const pickerChoice: { current: { kind: "new" } | { kind: "existing"; row: { id: string } } } = {
  current: { kind: "new" },
}
jest.mock("@/components/chat/terminal-tab-picker", () => ({
  TerminalTabPicker: ({
    children,
    onPick,
  }: {
    children: React.ReactNode
    onPick: (c: unknown) => void
  }) => (
    <div data-testid="terminal-tab-picker-stub" onClick={() => onPick(pickerChoice.current)}>
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
// Mutable so a test can exercise the "project supplies the terminal defaults"
// branch of the new-tab request as well as the bare no-project one.
type MockProject = {
  id: string
  rootDir?: string
  terminalConfig?: { shell?: string; cwd?: string; env?: Record<string, string> }
}
const mockProjects: { current: MockProject[]; activeId: string | null } = {
  current: [],
  activeId: null,
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (
    selector: (s: { projects: MockProject[]; activeProjectId: string | null }) => unknown
  ) => selector({ projects: mockProjects.current, activeProjectId: mockProjects.activeId }),
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

afterEach(() => {
  pickerChoice.current = { kind: "new" }
  mockProjects.current = []
  mockProjects.activeId = null
})

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

  // Without this the activity group's expand-all / collapse-all (and detailed
  // mode) silently skipped every Bash card in a run.
  it("opens while running and stays collapsed once settled, by default", () => {
    const { unmount } = render(<TerminalToolPart part={bashPart("input-available")} />)
    expect(screen.getByTestId("tool-wrapper")).toHaveAttribute("data-default-open", "true")
    unmount()
    render(<TerminalToolPart part={bashPart("output-available")} />)
    expect(screen.getByTestId("tool-wrapper")).toHaveAttribute("data-default-open", "false")
  })

  it("lets the caller override the open default (expand-all / detailed mode)", () => {
    const { unmount } = render(<TerminalToolPart part={bashPart("output-available")} defaultOpen />)
    expect(screen.getByTestId("tool-wrapper")).toHaveAttribute("data-default-open", "true")
    unmount()
    render(<TerminalToolPart part={bashPart("input-available")} defaultOpen={false} />)
    expect(screen.getByTestId("tool-wrapper")).toHaveAttribute("data-default-open", "false")
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
    const call = mockRunInDock.mock.calls[0]?.[0] as unknown as {
      chatSessionId: string
      command: string
    }
    expect(call.chatSessionId).toBe("chat-1")
    expect(call.command).toBe("ls -la")
  })

  it("routes an existing-tab pick to that tab instead of opening a new one", () => {
    pickerChoice.current = { kind: "existing", row: { id: "tab-7" } }
    render(<TerminalToolPart part={bashPart("input-available")} />)
    mockRunInDock.mockClear()
    screen.getByTestId("terminal-tab-picker-stub").click()
    const call = mockRunInDock.mock.calls[0]?.[0] as unknown as {
      tabId?: string
      newTab?: unknown
      command: string
    }
    expect(call.tabId).toBe("tab-7")
    expect(call.newTab).toBeUndefined()
    expect(call.command).toBe("ls -la")
  })

  it("seeds a new dock tab from the active project's terminal config", () => {
    mockProjects.current = [
      {
        id: "proj-1",
        rootDir: "/repo",
        terminalConfig: { shell: "/bin/fish", cwd: "  /repo/app  ", env: { FOO: "1" } },
      },
    ]
    mockProjects.activeId = "proj-1"
    render(<TerminalToolPart part={bashPart("input-available")} />)
    mockRunInDock.mockClear()
    screen.getByTestId("terminal-tab-picker-stub").click()
    const req = (
      mockRunInDock.mock.calls[0]?.[0] as unknown as {
        newTab: {
          req: { shell: string; cwd?: string; env?: Record<string, string>; projectId?: string }
        }
      }
    ).newTab.req
    expect(req.shell).toBe("/bin/fish")
    expect(req.cwd).toBe("/repo/app")
    expect(req.env).toEqual({ FOO: "1" })
    expect(req.projectId).toBe("proj-1")
  })

  it("falls back to the project root when the terminal config has no cwd", () => {
    mockProjects.current = [{ id: "proj-2", rootDir: "/repo", terminalConfig: { cwd: "   " } }]
    mockProjects.activeId = "proj-2"
    render(<TerminalToolPart part={bashPart("input-available")} />)
    mockRunInDock.mockClear()
    screen.getByTestId("terminal-tab-picker-stub").click()
    const req = (
      mockRunInDock.mock.calls[0]?.[0] as unknown as { newTab: { req: { cwd?: string } } }
    ).newTab.req
    expect(req.cwd).toBe("/repo")
  })

  it("shows no live output for a result object carrying neither stdout nor stderr", () => {
    render(
      <TerminalToolPart
        part={bashPart("input-available", {
          output: { exitCode: 0 } as unknown,
        } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-output", "")
  })

  it("hides Run-in-dock when the call carries no string command", () => {
    render(
      <TerminalToolPart
        part={bashPart("input-available", { input: { timeout: 30 } } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.queryByTestId("terminal-tool-part-run-in-dock")).toBeNull()
    expect(screen.queryByTestId("tool-input")).toBeNull()
  })
})
