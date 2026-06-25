import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChatTabStrip, type ChatTabInfo } from "./chat-tab-strip"
import { useChatStore } from "@/stores/chat"

// The tab strip is view-only over props, but each tab's live status dot reads
// `useSessionStatus(id)` from the real chat store — so we seed per-session
// status in `beforeEach` to exercise the streaming / awaiting / error dots.
// (The strip renders nothing when there is a single tab and no split.)

const tabs: readonly ChatTabInfo[] = [
  { id: "s-stream", title: "Refactor the composer" },
  { id: "s-wait", title: "Plan the migration" },
  { id: "s-error", title: "Fix the failing E2E suite" },
  { id: "s-idle", title: "" },
]

const seedStatuses = () => {
  const s = useChatStore.getState()
  s.setSessionStatus("s-stream", "streaming")
  s.setSessionStatus("s-wait", "awaiting_approval")
  s.setSessionStatus("s-error", "error")
  s.setSessionStatus("s-idle", "idle")
}

const meta = {
  title: "Chat/ChatTabStrip",
  component: ChatTabStrip,
  parameters: { layout: "padded" },
  args: {
    tabs,
    activeId: "s-stream",
    splitId: null,
    onSelect: fn(),
    onClose: fn(),
    onToggleSplit: fn(),
    onNew: fn(),
  },
  beforeEach: seedStatuses,
} satisfies Meta<typeof ChatTabStrip>

export default meta
type Story = StoryObj<typeof meta>

// Multiple tabs with mixed live statuses (streaming / awaiting / error / idle).
export const MixedStatuses: Story = {}

// Split view active — the second tab gets the primary ring; toggle is pressed.
export const SplitView: Story = {
  args: { splitId: "s-wait" },
}
