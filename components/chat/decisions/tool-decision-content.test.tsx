/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { ToolDecisionContent, bareToolName, shellCommandOf } from "./tool-decision-content"
import type { PendingApproval } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/components/chat/decisions/scheduled-task-approval-preview", () => ({
  isScheduleApprovalTool: (name: string) =>
    ["scheduler_create_task", "scheduler_delete_task"].includes(name),
  ScheduledTaskApprovalPreview: ({ toolName }: { toolName: string }) => (
    <div data-testid="schedule-preview" data-tool={toolName} />
  ),
}))

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    sessionId: "s1",
    requestId: "r1",
    toolUseID: "tu1",
    toolName: "bash",
    input: { command: "ls -la" },
    ...overrides,
  }
}

describe("bareToolName", () => {
  it("strips the cognia-tools MCP prefix and leaves everything else alone", () => {
    expect(bareToolName("mcp__cognia-tools__bash")).toBe("bash")
    expect(bareToolName("mcp__other__bash")).toBe("mcp__other__bash")
    expect(bareToolName(undefined)).toBe("")
  })
})

describe("<ToolDecisionContent />", () => {
  it("renders a shell command as a bash block, not a JSON dump", () => {
    render(<ToolDecisionContent approval={approval()} />)
    expect(screen.getByTestId("approval-bash-preview")).toBeInTheDocument()
    expect(screen.getByText(/ls -la/)).toBeInTheDocument()
  })

  it("renders an edit as a diff", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          toolName: "Edit",
          input: { file_path: "a.ts", old_string: "before", new_string: "after" },
        })}
      />
    )
    expect(screen.getByTestId("approval-edit-preview")).toBeInTheDocument()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
  })

  /**
   * The tool-aware branches all bound what they show; the generic fallback did
   * not. An approval carrying a large payload rendered the whole thing, which
   * on a phone is a scroll trap in front of a decision the run is blocked on.
   */
  it("truncates an oversized generic payload", () => {
    const huge = "x".repeat(20_000)
    const { container } = render(
      <ToolDecisionContent approval={approval({ toolName: "unknown_tool", input: { huge } })} />
    )
    const text = container.textContent ?? ""
    expect(text.length).toBeLessThan(9_000)
    expect(text).toContain("…")
  })

  it("attributes a subagent-origin request", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          origin: "subagent",
          subagentId: "researcher",
          subagentRunId: "abcdef123456",
        })}
      />
    )
    expect(screen.getByTestId("approval-subagent-origin")).toHaveTextContent("researcher")
    // Only the short run id, so the line stays readable on a phone.
    expect(screen.getByTestId("approval-subagent-origin")).toHaveTextContent("abcdef12")
  })

  it("shows the honest terminal notice for an interrupted decision", () => {
    render(<ToolDecisionContent approval={approval({ status: "interrupted" })} />)
    expect(screen.getByTestId("approval-interrupted-notice")).toHaveTextContent("interruptedNotice")
  })

  it("names the superseded cause for a decision replaced by a new instruction", () => {
    render(
      <ToolDecisionContent
        approval={approval({ status: "interrupted", interruptReason: "superseded" })}
      />
    )
    expect(screen.getByTestId("approval-interrupted-notice")).toHaveTextContent("supersededNotice")
  })

  /**
   * An observer may know a decision exists and which tool it names. The
   * arguments are the part carrying commands, file contents and credentials,
   * and it cannot answer the decision anyway.
   */
  it("withholds the arguments in observe mode but still names the tool", () => {
    render(<ToolDecisionContent approval={approval({ displayName: "Bash" })} mode="observe" />)
    expect(screen.getByTestId("approval-observe-redacted")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-bash-preview")).not.toBeInTheDocument()
    expect(screen.queryByText(/ls -la/)).not.toBeInTheDocument()
    expect(screen.getByText("Bash")).toBeInTheDocument()
  })
})

describe("<ToolDecisionContent /> · schedule writes", () => {
  it("shows a schedule write as the task it touches, not its JSON", () => {
    render(
      <ToolDecisionContent
        approval={approval({ toolName: "scheduler_delete_task", input: { taskId: "t1" } })}
      />
    )
    expect(screen.getByTestId("schedule-preview")).toHaveAttribute(
      "data-tool",
      "scheduler_delete_task"
    )
  })

  it("recognises the same tool when the SDK names it through the plugin bridge", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          toolName: "mcp__cognia-plugin-tools__scheduler_create_task",
          input: { name: "n" },
        })}
      />
    )
    expect(screen.getByTestId("schedule-preview")).toHaveAttribute(
      "data-tool",
      "scheduler_create_task"
    )
  })
})

describe("shellCommandOf", () => {
  it("reads a command from a shell-named tool regardless of its other keys", () => {
    expect(shellCommandOf("Bash", { command: "ls", timeout: 5, anything: true })).toBe("ls")
    expect(shellCommandOf("run_shell_command", { command: "pwd" })).toBe("pwd")
  })

  it("reads a command from any tool whose arguments are only shell arguments", () => {
    // An ACP agent titles the call freely ("Running: echo hi").
    expect(shellCommandOf("Running: echo hi", { command: "echo hi", cwd: "/w" })).toBe("echo hi")
  })

  it("joins an argv array, quoting only where needed", () => {
    expect(shellCommandOf("exec_command", { command: ["bash", "-lc", "echo hi"] })).toBe(
      "bash -lc 'echo hi'"
    )
    expect(shellCommandOf("exec_command", { cmd: ["echo", "it's"] })).toBe(`echo 'it'\\''s'`)
  })

  it("does not claim a non-shell tool that happens to carry a `command` key", () => {
    expect(shellCommandOf("slash_runner", { command: "deploy", target: "prod" })).toBeUndefined()
    expect(shellCommandOf("Bash", { command: "  " })).toBeUndefined()
    expect(shellCommandOf("Bash", { command: 42 })).toBeUndefined()
  })
})

describe("<ToolDecisionContent /> · external agent payloads", () => {
  it("renders Kimi Code's recovered Bash arguments as a command block", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          toolName: "Bash",
          title: "Bash",
          description: "Requesting approval to Running: echo hi",
          input: { command: "echo hi" },
        })}
      />
    )
    const command = screen.getByTestId("approval-bash-command")
    expect(command).toHaveTextContent("echo hi")
    expect(command).toHaveClass("font-mono", "whitespace-pre-wrap", "break-all")
    expect(screen.getByText("Requesting approval to Running: echo hi")).toBeInTheDocument()
  })

  it("lists the shell arguments the command block does not show", () => {
    render(
      <ToolDecisionContent
        approval={approval({ toolName: "Bash", input: { command: "make", timeout: 600000 } })}
      />
    )
    expect(screen.getByTestId("approval-bash-extra")).toHaveTextContent("600000")
  })

  it("falls back to the call's title — never a bare {} — when no arguments arrived", () => {
    const { container } = render(
      <ToolDecisionContent approval={approval({ toolName: "Bash", title: "Bash", input: {} })} />
    )
    const fallback = screen.getByTestId("approval-input-fallback")
    expect(fallback).toHaveTextContent("Bash")
    expect(fallback).toHaveTextContent("noInputDetails")
    expect(container.textContent).not.toContain("{}")
  })

  it("falls back to the tool name when there is no title either", () => {
    render(<ToolDecisionContent approval={approval({ toolName: "mystery", input: {} })} />)
    expect(screen.getByTestId("approval-input-fallback")).toHaveTextContent("mystery")
  })

  it("renders an ACP diff (mapped to the Edit shape) as a diff whatever the tool is called", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          toolName: "Edit /w/a.ts",
          input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
        })}
      />
    )
    expect(screen.getByTestId("approval-edit-preview")).toHaveTextContent("/w/a.ts")
  })

  it("renders several ACP diffs across files with each file named", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          toolName: "Apply patch",
          input: {
            edits: [
              { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
              { file_path: "/w/b.ts", old_string: "c", new_string: "d" },
            ],
          },
        })}
      />
    )
    const preview = screen.getByTestId("approval-multi-edit-preview")
    expect(preview).toHaveTextContent("/w/a.ts")
    expect(preview).toHaveTextContent("/w/b.ts")
  })

  it("keeps the JSON dump for an edit-like payload that carries other arguments", () => {
    render(
      <ToolDecisionContent
        approval={approval({
          toolName: "custom",
          input: { old_string: "a", new_string: "b", dangerous: true },
        })}
      />
    )
    expect(screen.queryByTestId("approval-edit-preview")).not.toBeInTheDocument()
  })
})
