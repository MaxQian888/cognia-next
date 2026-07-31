import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginQuickActionsMenu } from "./plugin-quick-actions-menu"
import {
  registerQuickAction,
  unregisterQuickActionsByPlugin,
} from "@/lib/plugin/registries/quick-action-registry"

// PluginQuickActionsMenu renders a single Zap dropdown listing every
// registered quick action whose `surfaces` include "composer". It returns null
// when no plugin contributed any, so the trigger only appears once the registry
// is seeded. We register a couple of composer-surface actions in `beforeEach`
// (with `run` inline handlers so dispatch is a no-op) and tear them down after.
const PLUGIN_ID = "storybook-demo"

const seedComposerActions = async () => {
  unregisterQuickActionsByPlugin(PLUGIN_ID)
  registerQuickAction(PLUGIN_ID, {
    id: "summarize-selection",
    title: "Summarize selection",
    description: "Condense the selected text into a one-line TL;DR",
    surfaces: ["composer"],
    run: () => {},
  })
  registerQuickAction(PLUGIN_ID, {
    id: "translate-zh",
    title: "Translate to 中文",
    description: "Translate the draft into Simplified Chinese",
    surfaces: ["composer"],
    run: () => {},
  })
}

const meta = {
  title: "Chat/Composer/PluginQuickActionsMenu",
  component: PluginQuickActionsMenu,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedComposerActions()
    return () => unregisterQuickActionsByPlugin(PLUGIN_ID)
  },
} satisfies Meta<typeof PluginQuickActionsMenu>

export default meta
type Story = StoryObj<typeof meta>

// Two composer-surface actions registered → the Zap trigger renders; click it
// to see the titled + described items.
export const WithActions: Story = {}

// Streaming in flight → the trigger is disabled.
export const Disabled: Story = {
  args: { disabled: true },
}
