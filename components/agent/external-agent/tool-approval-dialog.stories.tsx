import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ToolApprovalDialog, type ToolApprovalRequest } from "./tool-approval-dialog"

const lowRisk: ToolApprovalRequest = {
  id: "req-1",
  toolName: "read_file",
  toolDescription: "Read the contents of package.json",
  args: { path: "package.json" },
  riskLevel: "low",
}

const highRisk: ToolApprovalRequest = {
  id: "req-2",
  toolName: "execute_command",
  toolDescription: "Run a shell command in the workspace",
  args: { command: "rm -rf dist", cwd: "/repo" },
  riskLevel: "high",
}

const withOptions: ToolApprovalRequest = {
  id: "req-3",
  toolName: "write_file",
  toolDescription: "Overwrite src/index.ts",
  args: { path: "src/index.ts", bytes: 4096 },
  riskLevel: "medium",
  acpOptions: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once", isDefault: true },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ],
}

const meta = {
  title: "Agent/ExternalAgent/ToolApprovalDialog",
  component: ToolApprovalDialog,
  args: {
    request: lowRisk,
    open: true,
    onOpenChange: fn(),
    onApprove: fn(),
    onDeny: fn(),
    onSelectOption: fn(),
  },
} satisfies Meta<typeof ToolApprovalDialog>

export default meta
type Story = StoryObj<typeof meta>

// Low risk shows the "always allow" checkbox + approve/deny buttons.
export const LowRisk: Story = {}

export const HighRisk: Story = {
  args: { request: highRisk },
}

// ACP options replace the approve/deny pair with the agent-provided choices.
export const WithAcpOptions: Story = {
  args: { request: withOptions },
}

export const Closed: Story = {
  args: { open: false },
}
