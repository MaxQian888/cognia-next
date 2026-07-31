import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginConflictDialog } from "./plugin-conflict-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePluginsStore } from "@/stores/plugins"

// Conflict-detector report shown before completing an install. Severity-bucketed
// rows (high / medium / low) let the user triage; Continue proceeds, Abort
// closes. Driven by `usePluginsStore.conflictDialogTarget`.

const meta = {
  title: "Plugins/Dialogs/PluginConflictDialog",
  component: PluginConflictDialog,
  args: { onContinue: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginConflictDialog>

export default meta
type Story = StoryObj<typeof meta>

// Conflicts spanning all three severities.
export const MixedSeverities: Story = {
  beforeEach: () => {
    seedStore(usePluginsStore, {
      conflictDialogTarget: {
        pluginId: "com.acme.web-tools",
        conflicts: [
          {
            severity: "high",
            message: "Overrides the built-in screenshot tool.",
            relatedPluginId: "com.cognia.screenshot",
          },
          { severity: "medium", message: "Registers a command id used by another plugin." },
          { severity: "low", message: "Declares a theme name that already exists." },
        ],
      },
    })
    return () => resetStore(usePluginsStore)
  },
}
