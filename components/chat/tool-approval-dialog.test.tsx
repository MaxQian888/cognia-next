/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

import { ToolApprovalDialog } from "./tool-approval-dialog"
import type { PendingApproval } from "@/lib/claude/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code-block" data-language={language}>
      {code}
    </pre>
  ),
}))

function approval(overrides: Partial<PendingApproval>): PendingApproval {
  return {
    requestId: "r1",
    toolName: "some_tool",
    input: {},
    ...overrides,
  } as PendingApproval
}

describe("ToolApprovalDialog — input previews", () => {
  it("renders a bash command preview for the core bash tool", () => {
    render(
      <ToolApprovalDialog
        approval={approval({
          toolName: "mcp__cognia-tools__bash",
          input: { command: "git status", description: "show status" },
        })}
        onRespond={jest.fn()}
      />
    )
    const preview = screen.getByTestId("approval-bash-preview")
    expect(preview).toHaveTextContent("git status")
    expect(preview).toHaveTextContent("show status")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "bash")
  })

  it("renders a diff preview for edit payloads", () => {
    render(
      <ToolApprovalDialog
        approval={approval({
          toolName: "edit",
          input: { file_path: "src/a.ts", old_string: "x = 1", new_string: "x = 2" },
        })}
        onRespond={jest.fn()}
      />
    )
    const preview = screen.getByTestId("approval-edit-preview")
    expect(preview).toHaveTextContent("src/a.ts")
    expect(screen.getByTestId("diff-preview")).toBeInTheDocument()
  })

  it("renders one diff per edit for multi_edit payloads", () => {
    render(
      <ToolApprovalDialog
        approval={approval({
          toolName: "mcp__cognia-tools__multi_edit",
          input: {
            file_path: "src/a.ts",
            edits: [
              { old_string: "a", new_string: "b" },
              { old_string: "c", new_string: "d" },
            ],
          },
        })}
        onRespond={jest.fn()}
      />
    )
    expect(screen.getAllByTestId("diff-preview")).toHaveLength(2)
  })

  it("renders a content preview for write payloads", () => {
    render(
      <ToolApprovalDialog
        approval={approval({
          toolName: "write",
          input: { file_path: "new.ts", content: "export {}" },
        })}
        onRespond={jest.fn()}
      />
    )
    expect(screen.getByTestId("approval-write-preview")).toHaveTextContent("new.ts")
  })

  it("falls back to the JSON dump for unknown tools", () => {
    render(
      <ToolApprovalDialog
        approval={approval({ toolName: "mystery", input: { a: 1 } })}
        onRespond={jest.fn()}
      />
    )
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "json")
  })

  it("renders nothing meaningful when approval is null (dialog closed)", () => {
    render(<ToolApprovalDialog approval={null} onRespond={jest.fn()} />)
    expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
  })

  it("uses the explicit title and description when provided", () => {
    render(
      <ToolApprovalDialog
        approval={approval({
          toolName: "Bash",
          input: { command: "ls" },
          title: "Custom title",
          description: "why this is needed",
          decisionReason: "ruleset said ask",
        })}
        onRespond={jest.fn()}
      />
    )
    expect(screen.getByText("Custom title")).toBeInTheDocument()
    expect(screen.getByText("why this is needed")).toBeInTheDocument()
    expect(screen.getByText("ruleset said ask")).toBeInTheDocument()
    // Capital Bash routes to the bash preview without a description line.
    expect(screen.getByTestId("approval-bash-preview")).toBeInTheDocument()
  })

  it("write preview without a file_path still renders the diff", () => {
    render(
      <ToolApprovalDialog
        approval={approval({ toolName: "Write", input: { content: "abc" } })}
        onRespond={jest.fn()}
      />
    )
    expect(screen.getByTestId("approval-write-preview")).toBeInTheDocument()
    expect(screen.getByTestId("diff-preview")).toBeInTheDocument()
  })

  it("constrains width so long names/JSON don't overflow the dialog", () => {
    // Regression: a long namespaced tool name must wrap (`break-all`) and the
    // preview containers must be able to shrink (`min-w-0`) so the JSON/code
    // block scrolls inside its own box instead of stretching the dialog.
    render(
      <ToolApprovalDialog
        approval={approval({
          toolName: "mcp__cognia-plugin-tools__some_extremely_long_tool_name",
          input: { a: 1 },
        })}
        onRespond={jest.fn()}
      />
    )
    const name = screen.getByText("mcp__cognia-plugin-tools__some_extremely_long_tool_name")
    expect(name).toHaveClass("break-all")
    // The JSON preview sits inside a shrinkable (`min-w-0`) section.
    const preview = screen.getByTestId("code-block")
    expect(preview.closest(".min-w-0")).not.toBeNull()
  })

  it("responds with the chosen decision", () => {
    const onRespond = jest.fn()
    render(
      <ToolApprovalDialog
        approval={approval({ toolName: "bash", input: { command: "ls" } })}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "allowOnce" }))
    expect(onRespond).toHaveBeenCalledWith("allow")
    fireEvent.click(screen.getByRole("button", { name: "deny" }))
    expect(onRespond).toHaveBeenCalledWith("deny")
  })
})

describe("ToolApprovalDialog — interrupted state", () => {
  it("shows the interrupted notice and only a Dismiss action", () => {
    const onRespond = jest.fn()
    const onDismiss = jest.fn()
    render(
      <ToolApprovalDialog
        approval={approval({ toolName: "bash", status: "interrupted", interruptReason: "aborted" })}
        onRespond={onRespond}
        onDismiss={onDismiss}
      />
    )
    expect(screen.getByTestId("approval-interrupted-notice")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "allowOnce" })).toBeNull()
    expect(screen.queryByRole("button", { name: "deny" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onRespond).not.toHaveBeenCalled()
  })

  it("keeps the answerable footer for live approvals", () => {
    render(<ToolApprovalDialog approval={approval({ toolName: "bash" })} onRespond={jest.fn()} />)
    expect(screen.queryByTestId("approval-interrupted-notice")).toBeNull()
    expect(screen.getByRole("button", { name: "allowOnce" })).toBeInTheDocument()
  })
})
