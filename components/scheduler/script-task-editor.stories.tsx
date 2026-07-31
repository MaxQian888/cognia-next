import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ScriptTaskEditor } from "./script-task-editor"
import type { ExecuteScriptAction } from "@/types/scheduler"

// `ScriptTaskEditor` is a pure, controlled editor for an `ExecuteScriptAction`:
// language picker, code textarea (validation feedback appears as you type),
// a sandbox toggle, and a collapsible advanced section (timeout / memory /
// working dir / args). It's a plain section, not a dialog.
const pythonScript: ExecuteScriptAction = {
  type: "execute_script",
  language: "python",
  code: 'import sys\n\ndef main() -> int:\n    print("hello from the scheduler")\n    return 0\n\nif __name__ == "__main__":\n    sys.exit(main())\n',
  timeout_secs: 300,
  memory_mb: 512,
  use_sandbox: true,
  working_dir: "/home/user/jobs",
  args: ["--verbose", "--dry-run"],
}

const meta = {
  title: "Scheduler/ScriptTaskEditor",
  component: ScriptTaskEditor,
  parameters: { layout: "padded" },
  args: {
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScriptTaskEditor>

export default meta
type Story = StoryObj<typeof meta>

// Populated Python script with advanced settings filled in.
export const PythonScript: Story = {
  args: {
    value: pythonScript,
  },
}

// Empty Bash editor — the placeholder shows the language template.
export const EmptyBash: Story = {
  args: {
    value: {
      type: "execute_script",
      language: "bash",
      code: "",
      use_sandbox: true,
    },
  },
}

// A "Test" affordance appears when `onTest` is wired and there's code to run.
export const WithTestButton: Story = {
  args: {
    value: pythonScript,
    onTest: fn(),
  },
}

// Sandbox disabled — runs directly on the host.
export const SandboxDisabled: Story = {
  args: {
    value: { ...pythonScript, use_sandbox: false },
  },
}

// Read-only: every control is disabled (e.g. a workflow-managed script).
export const Disabled: Story = {
  args: {
    value: pythonScript,
    disabled: true,
  },
}
