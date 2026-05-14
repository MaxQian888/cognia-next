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
})
