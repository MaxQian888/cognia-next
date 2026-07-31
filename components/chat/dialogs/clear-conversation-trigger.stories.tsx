import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn, within, userEvent, waitFor, expect } from "storybook/test"

import { ClearConversationTrigger } from "./clear-conversation-trigger"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import type { UIMessage } from "ai"

// `ClearConversationTrigger` renders a destructive icon button that opens an
// AlertDialog. It gates on `useChatStore` (active session + at least one
// message) and confirms-clear through `useClearMessages()` (the data adapter).
// Stories seed the chat store directly and wrap in a mock `DataAdapterProvider`
// (the real one is mounted in app/layout.tsx) — no Dexie / sidecar.

const SID = "demo-session"

const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: fn(async () => {}),
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const msgs = (...m: unknown[]): UIMessage[] => m as unknown as UIMessage[]

function seed(messageCount: number, sessionId: string | null = SID) {
  const s = useChatStore.getState()
  s.setActiveSession(sessionId)
  if (sessionId) {
    s.replaceMessages(
      msgs(
        ...Array.from({ length: messageCount }, (_, i) => ({
          id: `m${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [{ type: "text", text: `message ${i}`, state: "done" }],
        }))
      )
    )
  }
}

const withAdapter = (Story: () => React.ReactElement) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="p-4">
      <Story />
    </div>
  </DataAdapterProvider>
)

const meta = {
  title: "Chat/Dialogs/ClearConversation",
  component: ClearConversationTrigger,
  parameters: { layout: "padded" },
  decorators: [withAdapter],
} satisfies Meta<typeof ClearConversationTrigger>

export default meta
type Story = StoryObj<typeof meta>

// Active session with messages — the destructive trash trigger renders.
export const Trigger: Story = {
  beforeEach: () => seed(4),
}

// Same trigger, dialog opened via the play function — the confirm copy +
// cancel / delete actions are visible.
export const DialogOpen: Story = {
  beforeEach: () => seed(4),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(document.body.textContent).toContain("Clear this conversation?"))
  },
}

// No messages to clear — the component renders nothing (the old toolbar's
// `messages.length > 0` gate). The frame is intentionally empty.
export const Hidden: Story = {
  beforeEach: () => seed(0),
}
