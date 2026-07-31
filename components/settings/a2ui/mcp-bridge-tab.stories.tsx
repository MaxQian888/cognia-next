import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpBridgeTab } from "./mcp-bridge-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { seedDb } from "@/lib/storybook/seed-db"
import { useA2UIStore } from "@/stores/a2ui"

// `McpBridgeTab` controls the always-on `a2ui-bridge` MCP server row + its
// per-agent `appsEnabled` projection matrix. It mounts `useBridgeHealth`
// (reports `isTauri: false` on the web preview, so the "Tauri only" notice
// shows) and looks up the bridge row in Dexie. When the bridge row is not
// seeded the tab renders its "not seeded" fallback — the branch a fresh
// web-preview database exercises.
const meta = {
  title: "Settings/A2UI/McpBridgeTab",
  component: McpBridgeTab,
  parameters: { layout: "padded" },
  beforeEach: async () => {
    resetStore(useA2UIStore)
    await seedDb(() => {})
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpBridgeTab>

export default meta
type Story = StoryObj<typeof meta>

// Bridge row not present in the empty database — the "not seeded" notice.
export const Default: Story = {}
