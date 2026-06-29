import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CommandPalette } from "./command-palette"

// Cmd-K command palette for the editor: add-node catalog, editor actions, and
// recent workflows. Pure props (open / callbacks); the recent-workflows group
// is Dexie-backed and resolves empty in Storybook. Open it to browse.
const meta = {
  title: "Workflow/Editor/CommandPalette",
  component: CommandPalette,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    currentWorkflowId: "wf_demo",
    onAddNode: fn(),
    onSave: fn(),
    onRun: fn(),
    onUndo: fn(),
    onRedo: fn(),
    onAutoLayout: fn(),
    onExportJson: fn(),
    onImportJsonRequest: fn(),
  },
} satisfies Meta<typeof CommandPalette>

export default meta
type Story = StoryObj<typeof meta>

// Full palette — add-node catalog + editor actions.
export const Open: Story = {}

// Minimal wiring: only the required actions are provided (optional ones omitted
// so their commands hide).
export const RequiredActionsOnly: Story = {
  args: {
    onRun: undefined,
    onUndo: undefined,
    onRedo: undefined,
    onAutoLayout: undefined,
    onExportJson: undefined,
    onImportJsonRequest: undefined,
  },
}
