import type { Meta, StoryObj } from "@storybook/nextjs"

import { ToolCallCard } from "./tool-call-card"
import type { ToolCallEntry } from "@/lib/agent-team/team-runtime-dispatcher"

const complete: ToolCallEntry = {
  id: "tc-1",
  name: "read_file",
  status: "complete",
  input: JSON.stringify({ path: "lib/agent/plan/runtime.ts" }, null, 2),
  output: "export function runPlan() { /* ... */ }",
}

const meta = {
  title: "Agent/Workspace/ToolCallCard",
  component: ToolCallCard,
  args: { call: complete },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolCallCard>

export default meta
type Story = StoryObj<typeof meta>

// Completed call; click the header to expand input/output.
export const Complete: Story = {}

export const Running: Story = {
  args: { call: { id: "tc-2", name: "bash", status: "running", input: "pnpm test" } },
}

// Error output routes through the structured ErrorParsedView.
export const Errored: Story = {
  args: {
    call: {
      id: "tc-3",
      name: "bash",
      status: "error",
      input: "pnpm build",
      output: "Error: Cannot find module '@/lib/missing'\n    at require (node:internal/modules)",
    },
  },
}

// No input/output → header is non-expandable.
export const NoDetails: Story = {
  args: { call: { id: "tc-4", name: "noop", status: "complete" } },
}
