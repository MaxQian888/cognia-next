/**
 * Tests for components/canvas/code-execution-panel.tsx
 *
 * Source ships idle / running / success / failed states, plus copy + clear
 * actions. Tooltip context and useCopy / hooks are mocked because the
 * component itself is the unit under test.
 */

import React from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CodeExecutionPanel } from "./code-execution-panel"
import type { CodeSandboxExecutionResult } from "@/hooks/canvas/use-code-execution"

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const mockCopy = jest.fn().mockResolvedValue(undefined)
let mockIsCopying = false
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copy: mockCopy, isCopying: mockIsCopying }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      codeExecution: "Code execution",
      simulated: "Simulated",
      stop: "Stop",
      run: "Run",
      output: "Output",
      exitCode: "Exit code",
      errors: "Errors",
      noOutput: "No output produced.",
      executing: "Executing…",
      executingCode: "Executing code…",
      readyToRun: "Ready to run",
      executionSuccess: "Completed successfully",
      executionFailed: "Execution failed",
      copyOutput: "Copy output",
      clearOutput: "Clear output",
    }
    return map[key] ?? key
  },
}))

function makeResult(
  overrides: Partial<CodeSandboxExecutionResult> = {}
): CodeSandboxExecutionResult {
  return {
    success: overrides.success ?? true,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    // Preserve explicit `null` so the "exitCode null branch" test can
    // exercise the conditional in the source.
    exitCode: "exitCode" in overrides ? overrides.exitCode! : 0,
    executionTime: overrides.executionTime ?? 12,
    isSimulated: overrides.isSimulated ?? false,
  } as CodeSandboxExecutionResult
}

const baseProps = {
  result: null as CodeSandboxExecutionResult | null,
  isExecuting: false,
  language: "python",
  onExecute: jest.fn(),
  onCancel: jest.fn(),
  onClear: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsCopying = false
  baseProps.onExecute = jest.fn()
  baseProps.onCancel = jest.fn()
  baseProps.onClear = jest.fn()
})

describe("CodeExecutionPanel — idle / ready", () => {
  it("renders the run button and language badge when idle", () => {
    render(<CodeExecutionPanel {...baseProps} />)
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument()
    expect(screen.getByText("python")).toBeInTheDocument()
    expect(screen.getByText("Code execution")).toBeInTheDocument()
  })

  it("calls onExecute when the run button is clicked", async () => {
    render(<CodeExecutionPanel {...baseProps} />)
    await userEvent.click(screen.getByRole("button", { name: /run/i }))
    expect(baseProps.onExecute).toHaveBeenCalledTimes(1)
  })

  it("does not render the terminal output region when there is no result and not executing", () => {
    render(<CodeExecutionPanel {...baseProps} />)
    // Terminal renders only when isExecuting OR result is set.
    expect(screen.queryByText("Output")).not.toBeInTheDocument()
  })
})

describe("CodeExecutionPanel — executing", () => {
  it("swaps to a stop button while executing and calls onCancel", async () => {
    render(<CodeExecutionPanel {...baseProps} isExecuting={true} />)
    const stop = screen.getByRole("button", { name: /stop/i })
    expect(stop).toBeInTheDocument()
    await userEvent.click(stop)
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
  })

  it("renders the executing-code message when running with no result yet", () => {
    render(<CodeExecutionPanel {...baseProps} isExecuting={true} />)
    expect(screen.getByText("Executing code…")).toBeInTheDocument()
  })
})

describe("CodeExecutionPanel — success result", () => {
  it("renders stdout in a pre block and a successful status", () => {
    render(
      <CodeExecutionPanel
        {...baseProps}
        result={makeResult({ stdout: "hello world", success: true })}
      />
    )
    // Terminal renders the output prop AND the stdout pre block — both
    // contain "hello world".
    expect(screen.getAllByText("hello world").length).toBeGreaterThan(0)
    expect(screen.getByText("Completed successfully")).toBeInTheDocument()
  })

  it("renders the no-output message when success and both streams are empty", () => {
    render(
      <CodeExecutionPanel
        {...baseProps}
        result={makeResult({ stdout: "", stderr: "", success: true })}
      />
    )
    expect(screen.getByText("No output produced.")).toBeInTheDocument()
  })

  it("shows the simulated badge when result.isSimulated is true", () => {
    render(
      <CodeExecutionPanel {...baseProps} result={makeResult({ stdout: "x", isSimulated: true })} />
    )
    expect(screen.getByText("Simulated")).toBeInTheDocument()
  })

  it("renders exitCode label when not null", () => {
    render(<CodeExecutionPanel {...baseProps} result={makeResult({ stdout: "x", exitCode: 0 })} />)
    expect(screen.getByText(/Exit code: 0/)).toBeInTheDocument()
  })
})

describe("CodeExecutionPanel — failed result", () => {
  it("renders stderr inside the errors region", () => {
    render(
      <CodeExecutionPanel
        {...baseProps}
        result={makeResult({ stderr: "boom", success: false, exitCode: 1 })}
      />
    )
    expect(screen.getAllByText("boom").length).toBeGreaterThan(0)
    expect(screen.getByText(/Errors:/)).toBeInTheDocument()
    expect(screen.getByText("Execution failed")).toBeInTheDocument()
  })

  it("renders exitCode 1 with the destructive style", () => {
    render(
      <CodeExecutionPanel
        {...baseProps}
        result={makeResult({ stderr: "x", success: false, exitCode: 1 })}
      />
    )
    expect(screen.getByText(/Exit code: 1/)).toBeInTheDocument()
  })
})

describe("CodeExecutionPanel — copy / clear actions", () => {
  it("calls useCopy.copy with the joined output when copy is clicked", async () => {
    render(
      <CodeExecutionPanel {...baseProps} result={makeResult({ stdout: "out", stderr: "err" })} />
    )
    const copyButtons = screen.getAllByLabelText("Copy output")
    await userEvent.click(copyButtons[0])
    expect(mockCopy).toHaveBeenCalledWith("out\n\nerr")
  })

  it("disables the copy button when there is no terminal output", () => {
    render(<CodeExecutionPanel {...baseProps} result={makeResult({ stdout: "", stderr: "" })} />)
    const buttons = screen.getAllByLabelText("Copy output")
    expect(buttons[0]).toBeDisabled()
  })

  it("calls onClear when the clear button is clicked", async () => {
    render(<CodeExecutionPanel {...baseProps} result={makeResult({ stdout: "out" })} />)
    await userEvent.click(screen.getByLabelText("Clear output"))
    expect(baseProps.onClear).toHaveBeenCalledTimes(1)
  })

  it("does not invoke copy when the output string is empty", async () => {
    render(<CodeExecutionPanel {...baseProps} result={makeResult({ stdout: "", stderr: "" })} />)
    // Disabled button — clicking does nothing.
    const buttons = screen.getAllByLabelText("Copy output")
    await userEvent.click(buttons[0])
    expect(mockCopy).not.toHaveBeenCalled()
  })
})

describe("CodeExecutionPanel — exitCode null branch", () => {
  it("omits the exit code line when exitCode is null", () => {
    render(
      <CodeExecutionPanel
        {...baseProps}
        result={makeResult({ stdout: "x", exitCode: null as unknown as number })}
      />
    )
    expect(screen.queryByText(/Exit code:/)).not.toBeInTheDocument()
  })
})
