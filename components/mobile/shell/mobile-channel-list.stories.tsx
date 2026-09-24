import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MobileChannelList } from "./mobile-channel-list"
import { seedDb } from "@/lib/storybook/seed-db"
import type { ChatSession } from "@cognia/agent-config-types"

// Mobile conversation list: search + New chat, the Chats/Archived view with
// search reach and filters, and a windowed list of pinned / grouped sections
// built by the shared `useConversationListModel`. Sessions are a prop;
// characters + unread counts come from the (empty) Storybook DB through the
// list's standalone source. Rows host swipe + long-press (action sheet).
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
    onSetPinned: fn(),
    onAssignToFolder: fn(),
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

// Cold start: the session query has not answered yet — skeleton rows, never
// the "No chats yet" copy.
export const Loading: Story = {
  args: { sessions: [], activeSessionId: null, isLoadingSessions: true },
}

// 400 conversations, to see the windowing and the restored scroll position.
export const ManyConversations: Story = {
  args: {
    sessions: Array.from({ length: 400 }, (_, index) =>
      session({
        id: `s-many-${index}`,
        title: `Conversation ${index + 1} — a title long enough to ellipsize in a 262px column`,
        updatedAt: now - index * 3_600_000,
      })
    ),
    activeSessionId: "s-many-120",
  },
}

// The 375px drawer column (85vw minus the guild rail), where titles ellipsize
// and the header controls must all stay on screen.
export const NarrowPhone: Story = {
  decorators: [
    (Story) => (
      <div className="mx-auto flex h-[760px] w-[262px] overflow-hidden border">
        <Story />
      </div>
    ),
  ],
}
