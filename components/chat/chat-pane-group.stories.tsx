import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import { fn } from "storybook/test"

import { ChatPaneGroup } from "./chat-pane-group"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@/lib/claude/types"

// Concurrent-chat pane layout: the open-session tab strip plus one or two live
// ChatPanes (split view), each bound to its own session slice.
const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withChrome = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="flex h-screen w-full flex-col">
      <Story />
    </div>
  </DataAdapterProvider>
)

const session = (id: string, title: string): ChatSession =>
  ({
    id,
    title,
    characterId: "claude",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }) as ChatSession

const SESSIONS = [session("s1", "Refactor composer"), session("s2", "Write tests")]

const seedOpen =
  (ids: string[], opts: { split?: boolean } = {}) =>
  () => {
    resetStore(useChatStore)
    const s = useChatStore.getState()
    for (const id of ids) s.setActiveSession(id)
    s.setActiveSession(ids[0]!)
    if (opts.split && ids[1]) s.setSplitSessionId(ids[1])
  }

const meta = {
  title: "Chat/ChatPaneGroup",
  component: ChatPaneGroup,
  parameters: { layout: "fullscreen" },
  decorators: [withChrome],
  args: {
    sessions: SESSIONS,
    send: fn(),
    stop: fn(),
    steerNow: fn(),
    steerFlush: fn(),
    regenerate: fn(),
    editResend: fn(),
    respondToApproval: fn(),
    closePane: fn(),
    onCreate: fn(),
    onUseSample: fn(),
    onOpenSettings: fn(),
  },
  beforeEach: seedOpen(["s1", "s2"]),
} satisfies Meta<typeof ChatPaneGroup>

export default meta
type Story = StoryObj<typeof meta>

/** Two open tabs, single active pane. */
export const SinglePane: Story = {}

/** Split view — two panes side by side, each its own session. */
export const SplitView: Story = {
  beforeEach: seedOpen(["s1", "s2"], { split: true }),
}
