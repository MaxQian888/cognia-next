import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginTriggersTab } from "./plugin-triggers-tab"

// Per-plugin workflow-trigger subscriptions, with a per-(kind, workflow) mute
// toggle. Subscriptions come from the live trigger registry via
// `useSyncExternalStore`; the registry is empty in Storybook, so this renders
// the empty state with the mute hint.

const meta = {
  title: "Plugins/Detail/PluginTriggersTab",
  component: PluginTriggersTab,
  args: { pluginId: "com.acme.web-tools" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[480px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginTriggersTab>

export default meta
type Story = StoryObj<typeof meta>

// No trigger subscriptions → empty state.
export const Empty: Story = {}
