/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { TerminalToolPart } from "./terminal-tool-part"

jest.mock("ansi-to-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock("@/components/ai-elements/shimmer", () => ({
  Shimmer: ({ children, className }: { children: string; className?: string }) => (
    <span data-testid="shimmer" className={className}>
      {children}
    </span>
  ),
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ReadingCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="reading-collapse">{children}</div> : null,
}))

jest.mock("@/components/error/error-parsed-view", () => ({
  ErrorParsedView: ({ rawError }: { rawError?: unknown }) => (
    <div data-testid="error-parsed-view">{String(rawError ?? "")}</div>
  ),
}))

jest.mock("@/components/chat/message-parts/tool-semantic-badges", () => ({
  ToolSemanticBadges: ({ readOnlyHint }: { readOnlyHint?: boolean | null }) => (
    <span data-testid="semantic-badges" data-read-only={String(readOnlyHint)} />
  ),
}))

jest.mock("@/lib/chat/tool-summary", () => ({
  resolveToolDisplayTitle: (part: { title?: string }) => part.title ?? "Bash",
}))

const mockCopy = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copy: mockCopy, copied: false, isCopying: false }),
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
jest.mock("@/lib/terminal/shell-detect", () => ({
  resolveDefaultShell: (opts: { projectShell?: string; settingShell?: string }) =>
    opts.projectShell ?? opts.settingShell ?? "/bin/zsh",
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
  mockRunInDock.mockClear()
  mockCopy.mockClear()
})

describe("TerminalToolPart", () => {
  it("renders the command as an inline row while running, expanded with live output", () => {
    render(
      <TerminalToolPart
        part={bashPart("input-available", {
          output: { stdout: "hello", stderr: "warn" } as unknown,
        })}
      />
    )

    const row = screen.getByTestId("terminal-tool-part")
    expect(row).toHaveAttribute("data-status", "input-available")
    // Row shows the command and the running meta.
    expect(screen.getByRole("button", { name: /ls -la/ })).toBeInTheDocument()
    expect(screen.getByText("Running")).toBeInTheDocument()
    // The command sweeps a shimmer while the call is in flight.
    expect(screen.getByTestId("shimmer")).toHaveTextContent("ls -la")
    // Expanded by default while running; the themed output block joins streams.
    const out = screen.getByTestId("terminal-tool-output")
    expect(out).toHaveAttribute("data-streaming", "true")
    expect(out).toHaveTextContent("hello")
    expect(out).toHaveTextContent("warn")
    // The output block echoes the full command like a terminal transcript.
    expect(out).toHaveTextContent("$ ls -la")
  })

  it("stays collapsed once settled and toggles open on click", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-available", { output: "done" } as Partial<ToolUIPart>)}
      />
    )
    const toggle = screen.getByRole("button", { name: /ls -la/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("reading-collapse")).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("reading-collapse")).toBeInTheDocument()
  })

  it("lets the caller seed the open default (expand-all / detailed mode)", () => {
    const { unmount } = render(<TerminalToolPart part={bashPart("output-available")} defaultOpen />)
    expect(screen.getByRole("button", { name: /ls -la/ })).toHaveAttribute("aria-expanded", "true")
    unmount()
    render(<TerminalToolPart part={bashPart("input-available")} defaultOpen={false} />)
    expect(screen.getByRole("button", { name: /ls -la/ })).toHaveAttribute("aria-expanded", "false")
  })

  it("opens by default for a failed call and shows the parsed error view", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-error", { errorText: "boom" } as unknown as ToolUIPart)}
      />
    )
    expect(screen.getByRole("button", { name: /ls -la/ })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("error-parsed-view")).toHaveTextContent("boom")
  })

  it("shows exit code meta for a completed object result", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-available", {
          output: { stdout: "ok", exitCode: 0 } as unknown,
        } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.getByText("exit 0")).toBeInTheDocument()
  })

  it("marks a non-zero exit code as an error meta", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-available", {
          output: { stderr: "bad", exitCode: 125 } as unknown,
        } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.getByText("exit 125")).toBeInTheDocument()
  })

  it("falls back to a line-count meta for plain string output", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-available", { output: "a\nb\nc" } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.getByText("3 lines")).toBeInTheDocument()
  })

  it("truncates multi-line commands to the first line with a +N hint", () => {
    render(
      <TerminalToolPart
        part={bashPart("output-available", {
          input: { command: "cat <<'EOF' > /tmp/x\nline two\nline three\nEOF" },
          output: "done",
        } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.getByText("cat <<'EOF' > /tmp/x")).toBeInTheDocument()
    expect(screen.getByText("+3 lines")).toBeInTheDocument()
    // Expanded echo keeps the full command.
    fireEvent.click(screen.getByRole("button", { name: /cat <</ }))
    expect(screen.getByTestId("terminal-tool-output")).toHaveTextContent("line two")
  })

  it("renders the Run-in-dock affordance when a command is present", () => {
    render(<TerminalToolPart part={bashPart("input-available")} />)
    expect(screen.getByTestId("terminal-tool-part-run-in-dock")).toBeInTheDocument()
  })

  it("clicking Run-in-dock through the picker forwards the command via runInDockTab", () => {
    render(<TerminalToolPart part={bashPart("input-available")} />)
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
    screen.getByTestId("terminal-tab-picker-stub").click()
    const req = (
      mockRunInDock.mock.calls[0]?.[0] as unknown as { newTab: { req: { cwd?: string } } }
    ).newTab.req
    expect(req.cwd).toBe("/repo")
  })

  it("copies the full command via the hover action", () => {
    render(
      <TerminalToolPart
        part={bashPart("input-available", {
          input: { command: "echo one\necho two" },
        })}
      />
    )
    fireEvent.click(screen.getByTestId("terminal-tool-copy-command"))
    expect(mockCopy).toHaveBeenCalledWith("echo one\necho two")
  })

  it("hides Run-in-dock when the call carries no string command", () => {
    render(
      <TerminalToolPart
        part={bashPart("input-available", { input: { timeout: 30 } } as Partial<ToolUIPart>)}
      />
    )
    expect(screen.queryByTestId("terminal-tool-part-run-in-dock")).toBeNull()
  })
})

it("honors controlled disclosure and keeps its row mounted", () => {
  const onToggle = jest.fn()
  const tool = bashPart("output-available")
  const { getByTestId, rerender } = render(
    <TerminalToolPart part={tool} expanded={false} onToggle={onToggle} />
  )
  const toggle = getByTestId("terminal-tool-part-toggle")
  fireEvent.click(toggle)
  expect(onToggle).toHaveBeenCalledTimes(1)
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  rerender(<TerminalToolPart part={tool} expanded onToggle={onToggle} />)
  expect(getByTestId("terminal-tool-part-toggle")).toBe(toggle)
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
})
