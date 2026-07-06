import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SubagentImportDialog } from "./subagent-import-dialog"

// `SubagentImportDialog` is a three-step wizard (source → files → review) that
// imports external subagent configs (Claude Code / Codex / Cursor / Cline /
// generic markdown) into the SubAgentTemplate registry or the Character
// library. Prop-driven: `open` / `onOpenChange` / `onImported`. On the web
// preview the file step renders the browser `<input type=file>` pickers.
const meta = {
  title: "Settings/Subagents/SubagentImportDialog",
  component: SubagentImportDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onImported: fn(),
  },
} satisfies Meta<typeof SubagentImportDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open at step 1 — pick the source adapter (auto-detect by default).
export const Open: Story = {}

// Closed — nothing rendered (the trigger lives in the parent toolbar).
export const Closed: Story = {
  args: { open: false },
}
