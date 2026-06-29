import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginPanelToolbar } from "./plugin-panel-toolbar"
import { resetStore } from "@/lib/storybook/seed-stores"
import { usePluginsStore } from "@/stores/plugins"

// Panel toolbar — import / install-from-URL / check-updates / sync-registry
// controls. The check-updates and sync-registry actions are wired through props;
// import + URL install open their own dialogs.

const meta = {
  title: "Plugins/PluginPanelToolbar",
  component: PluginPanelToolbar,
  args: { onCheckUpdates: fn(), onSyncRegistry: fn(), syncing: false },
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(usePluginsStore)
    return () => resetStore(usePluginsStore)
  },
} satisfies Meta<typeof PluginPanelToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Registry sync in progress.
export const Syncing: Story = { args: { syncing: true } }
