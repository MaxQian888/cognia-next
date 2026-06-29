import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileChannelList } from "./mobile-channel-list"
import { seedDb } from "@/lib/storybook/seed-db"
import type { ChatSession } from "@/lib/claude/types"

// Mobile conversation list: search + archive toggle + new, with date-bucketed /
// pinned sections built by the shared `useConversationListModel`. Sessions are a
// prop; characters + unread counts come from the (empty) Storybook DB. The list
// rows host swipe + long-press interactions.
const now = Date.now()
function session(over: Partial<ChatSession> & Pick<ChatSession, "id" | "title">): ChatSession {
  return {
    createdAt: now - 86_400_000,
    updatedAt: now - 3_600_000,
    ...over,
  }
}

const sessions: ChatSession[] = [
  session({ id: "s-pinned", title: "Quarterly planning", pinned: true, updatedAt: now - 600_000 }),
  session({ id: "s-today", title: "Bug triage", updatedAt: now - 1_800_000 }),
  session({ id: "s-yesterday", title: "Design review", updatedAt: now - 26 * 3_600_000 }),
  session({ id: "s-week", title: "Onboarding checklist", updatedAt: now - 4 * 86_400_000 }),
]

const meta = {
  title: "Mobile/Shell/MobileChannelList",
  component: MobileChannelList,
  parameters: { layout: "fullscreen" },
  args: {
    sessions,
    activeSessionId: "s-today",
    onSelect: fn(),
    onNewDirect: fn(),
    onDelete: fn(),
    onRename: fn(),
    onArchive: fn(),
    onUnarchive: fn(),
  },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-hidden border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileChannelList>

export default meta
type Story = StoryObj<typeof meta>

export const WithSessions: Story = {}

export const Empty: Story = {
  args: { sessions: [], activeSessionId: null },
}
