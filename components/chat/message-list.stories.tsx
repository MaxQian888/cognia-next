import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import { fn } from "storybook/test"

import { MessageList } from "./message-list"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"

// The scrollable conversation body: renders each message via MessageRenderer,
// plus the thinking indicator while streaming. Reads characters from the data
// adapter and the active session id from the chat store.
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
    <div className="h-[80vh] w-full">
      <Story />
    </div>
  </DataAdapterProvider>
)

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text, state: "done" }] }) as unknown as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as UIMessage

const CONVERSATION: UIMessage[] = [
  user("u1", "What are the limits of Next.js static export?"),
  assistant("a1", "No runtime server — `app/api/`, ISR, and middleware are unavailable."),
  user("u2", "So where does backend logic live?"),
  assistant("a2", "In Tauri's Rust side (axum), or a Capacitor native plugin."),
]

const meta = {
  title: "Chat/MessageList",
  component: MessageList,
  parameters: { layout: "fullscreen" },
  decorators: [withChrome],
  args: {
    messages: CONVERSATION,
    status: "idle",
    onCopy: fn(),
    onRegenerate: fn(),
    onEditResend: fn(),
  },
  beforeEach: () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
  },
} satisfies Meta<typeof MessageList>

export default meta
type Story = StoryObj<typeof meta>

/** A short, idle conversation. */
export const Conversation: Story = {}

/** Streaming: the last turn is the user's, so the thinking indicator shows. */
export const Thinking: Story = {
  args: {
    messages: [user("u1", "Refactor this for readability.")],
    status: "streaming",
  },
}

/** Empty list — nothing to render. */
export const Empty: Story = {
  args: { messages: [] },
}
