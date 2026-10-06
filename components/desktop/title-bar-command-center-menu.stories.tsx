import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TitleBarCommandCenterMenu } from "./title-bar-command-center-menu"
import { TitleBarZone } from "./title-bar-zone"
import { getBarCatalog } from "@/lib/shell/bar-items"

// The command-center caret dropdown beside the title-bar pill. Carries no store
// subscriptions — data + handlers are injected by `TitleBar`. Click the caret to
// open the menu (command palette, recent sessions, go-to-view).
const recentSessions = [
  { id: "s1", title: "Refactor the auth flow" },
  { id: "s2", title: "Investigate flaky test", characterId: "c1" },
  { id: "s3", title: "Release notes draft" },
]

const meta = {
  title: "Desktop/TitleBarCommandCenterMenu",
  component: TitleBarCommandCenterMenu,
  parameters: { layout: "centered" },
  args: {
    recentSessions,
    onCommandPalette: fn(),
    onOpenRecentSession: fn(),
    onGo: fn(),
  },
} satisfies Meta<typeof TitleBarCommandCenterMenu>

export default meta
type Story = StoryObj<typeof meta>

export const WithRecentSessions: Story = {}

export const NoRecentSessions: Story = {
  args: { recentSessions: [] },
}

export const CompactNavigation: Story = {
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
  render: (args) => (
    <div className="flex h-10 min-w-0 items-center justify-end gap-1 border-b px-2">
      <TitleBarZone
        compact
        items={getBarCatalog("title", "tauri").filter((item) =>
          ["navArrows", "workspace", "search", "commandCenter"].includes(item.id)
        )}
        ctx={{
          ...args,
          appName: "Cognia",
          separator: " — ",
          searchPlaceholder: "",
          kbdHint: "⌘K",
        }}
      />
    </div>
  ),
}
