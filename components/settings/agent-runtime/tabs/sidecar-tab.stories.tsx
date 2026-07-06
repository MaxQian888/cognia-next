import type { Meta, StoryObj } from "@storybook/nextjs"

import { SidecarTab } from "./sidecar-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// `SidecarTab` is a read-only diagnostics surface for the in-process Claude SDK
// sidecar: status badge, SDK/sidecar versions, and live counts (sessions,
// slash commands, hooks, MCP servers) read from Dexie. The status polling +
// restart button are Tauri-only — on the web preview the status shows
// "web only" and the restart button is disabled.
const meta = {
  title: "Settings/AgentRuntime/Tabs/SidecarTab",
  component: SidecarTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidecarTab>

export default meta
type Story = StoryObj<typeof meta>

// Web preview: "web only" status badge, empty Dexie counts, restart disabled.
export const Default: Story = {}
