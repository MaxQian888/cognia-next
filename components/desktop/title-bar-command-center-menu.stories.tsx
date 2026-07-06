import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TitleBarCommandCenterMenu } from "./title-bar-command-center-menu"

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
