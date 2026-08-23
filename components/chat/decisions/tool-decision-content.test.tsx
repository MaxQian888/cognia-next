/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { ToolDecisionContent, bareToolName } from "./tool-decision-content"
import type { PendingApproval } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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
    expect(screen.getByTestId("approval-interrupted-notice")).toBeInTheDocument()
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
