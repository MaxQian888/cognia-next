import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginDataDialog, type PluginDataDialogArgs } from "./plugin-data-dialog"
import { Dialog, DialogContent } from "@/components/ui/dialog"

// Data-driven dialog backing the plugin `ctx.ui.showDialog` / `showInputDialog`
// / `showConfirmDialog` APIs. Normally pushed onto the plugin modal stack by
// `PluginModalRoot` (which supplies the surrounding Dialog); the decorator here
// mirrors that wrapper so the content renders standalone.

// The modal store passes `args` as an opaque `Record<string, unknown>`; the
// component narrows it to `PluginDataDialogArgs` at runtime. Cast through that
// for the stories.
const asArgs = (a: PluginDataDialogArgs): Record<string, unknown> =>
  a as unknown as Record<string, unknown>

const meta = {
  title: "Plugins/Dialogs/PluginDataDialog",
  component: PluginDataDialog,
  args: { modalId: "story-modal", onClose: fn() },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent>
          <Story />
        </DialogContent>
      </Dialog>
    ),
  ],
} satisfies Meta<typeof PluginDataDialog>

export default meta
type Story = StoryObj<typeof meta>

const dialogArgs: PluginDataDialogArgs = {
  kind: "dialog",
  options: { title: "Export complete", content: "Your report was saved to Downloads." },
  settle: fn(),
}

const confirmArgs: PluginDataDialogArgs = {
  kind: "confirm",
  options: {
    title: "Delete all cached pages?",
    message: "This frees disk space but the plugin will re-fetch on next use.",
  },
  settle: fn(),
}

const inputArgs: PluginDataDialogArgs = {
  kind: "input",
  options: {
    title: "Rename workspace",
    message: "Enter a new name for this workspace.",
    defaultValue: "My Workspace",
  },
  settle: fn(),
}

// Single-action informational dialog.
export const InfoDialog: Story = { args: { args: asArgs(dialogArgs) } }

// Confirm / cancel dialog.
export const ConfirmDialog: Story = { args: { args: asArgs(confirmArgs) } }

// Text-input prompt with a default value.
export const InputDialog: Story = { args: { args: asArgs(inputArgs) } }
