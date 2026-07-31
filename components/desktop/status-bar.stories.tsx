import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBar } from "./status-bar"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat/chat-store"
import { useUIStore } from "@/stores/ui/ui-store"

// VSCode-style bottom status bar: runtime badge, active-session label, permission
// mode, theme/zoom/locale toggles, notifications, and the job center. Reads the
// chat + UI stores; the rest derives from settings / Dexie (empty by default).
const meta = {
  title: "Desktop/StatusBar",
  component: StatusBar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStores(useChatStore, useUIStore)
  },
} satisfies Meta<typeof StatusBar>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Streaming: Story = {
  beforeEach: () => {
    resetStores(useChatStore, useUIStore)
    useChatStore.setState({ status: "streaming" })
  },
}

export const AwaitingApproval: Story = {
  beforeEach: () => {
    resetStores(useChatStore, useUIStore)
    useChatStore.setState({ status: "awaiting_approval", permissionMode: "acceptEdits" })
  },
}
