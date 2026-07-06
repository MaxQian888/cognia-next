import type { Meta, StoryObj } from "@storybook/nextjs"

import { HistoryLoadEarlier } from "./history-load-earlier"

// "Load earlier messages" bar. Hydration is Tauri-only — in the Storybook web
// shell `useHistoryHydration` reports `canHydrate: false`, so the button
// renders disabled with the desktop-only hint. That web branch is what we
// story here.
const meta = {
  title: "Inbox/HistoryLoadEarlier",
  component: HistoryLoadEarlier,
  args: { conversationKey: "slack:adapter-1:C1", adapterId: "adapter-1" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HistoryLoadEarlier>

export default meta
type Story = StoryObj<typeof meta>

export const WebDisabled: Story = {}
