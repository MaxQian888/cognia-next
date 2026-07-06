import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginMessagingCard } from "./plugin-messaging-card"

// Reads the client-only IPC + message-bus singletons on mount (no Tauri, no
// Dexie). In the Storybook browser those singletons exist but carry no traffic,
// so the stats grid reads zero and the exposed-methods list shows its empty
// note — a faithful "no plugin messaging yet" snapshot. The Refresh button
// recomputes the snapshot on demand.
const meta = {
  title: "Settings/Sections/PluginMessagingCard",
  component: PluginMessagingCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginMessagingCard>

export default meta
type Story = StoryObj<typeof meta>

// Idle singletons → zeroed stats + empty exposed-methods list.
export const Default: Story = {}
