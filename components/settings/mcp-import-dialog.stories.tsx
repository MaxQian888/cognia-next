import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { Button } from "@/components/ui/button"
import { McpImportDialog } from "./mcp-import-dialog"

// `McpImportDialog` is a three-step dialog (pick agent → preview servers → choose
// strategy) that imports MCP servers from an external agent's config file. Agent
// probing happens through the Tauri runtime on open. The dialog starts closed,
// so the rendered surface is the trigger button; a custom render-prop trigger is
// also supported.
const meta = {
  title: "Settings/McpImportDialog",
  component: McpImportDialog,
  parameters: { layout: "centered" },
  args: {
    onImported: fn(),
  },
} satisfies Meta<typeof McpImportDialog>

export default meta
type Story = StoryObj<typeof meta>

// Default "Import…" trigger button (dialog closed).
export const Default: Story = {}

// A caller-supplied trigger replaces the default button.
export const CustomTrigger: Story = {
  args: {
    trigger: <Button variant="outline">Import from agent config</Button>,
  },
}
