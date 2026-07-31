import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CodeExecutionPanel } from "./code-execution-panel"
import type { CodeSandboxExecutionResult } from "@/hooks/canvas/use-code-execution"

// CodeExecutionPanel is a pure result viewer for sandboxed code runs. It shows
// a status header (idle / running / success / failure), a Run/Stop button, and
// a terminal with stdout/stderr. The `useCopy` hook it uses is render-safe.
const meta = {
  title: "Canvas/CodeExecutionPanel",
  component: CodeExecutionPanel,
  parameters: { layout: "fullscreen" },
  args: {
    language: "javascript",
    onExecute: fn(),
    onCancel: fn(),
    onClear: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeExecutionPanel>

export default meta
type Story = StoryObj<typeof meta>

const success: CodeSandboxExecutionResult = {
  success: true,
  sandbox: "iframe",
  stdout: "Hello, Canvas\n42\n",
  stderr: "",
  exitCode: 0,
  durationMs: 87,
  executionTime: 87,
  language: "javascript",
}

const failure: CodeSandboxExecutionResult = {
  success: false,
  sandbox: "iframe",
  stdout: "",
  stderr: "ReferenceError: total is not defined\n    at <anonymous>:3:13",
  exitCode: 1,
  durationMs: 54,
  executionTime: 54,
  language: "javascript",
}

// No result yet — header shows the idle "ready to run" state, output hidden.
export const Idle: Story = {
  args: {
    result: null,
    isExecuting: false,
  },
}

// Currently executing — spinner header, streaming terminal, indeterminate progress.
export const Executing: Story = {
  args: {
    result: null,
    isExecuting: true,
  },
}

// Successful run with stdout and a zero exit code.
export const Success: Story = {
  args: {
    result: success,
    isExecuting: false,
  },
}

// Failed run with stderr and a non-zero exit code.
export const Failure: Story = {
  args: {
    result: failure,
    isExecuting: false,
  },
}

// A simulated run (no native sandbox available) shows the "simulated" badge.
export const Simulated: Story = {
  args: {
    result: { ...success, isSimulated: true, stdout: "(simulated) Hello, Canvas\n" },
    isExecuting: false,
    language: "python",
  },
}
