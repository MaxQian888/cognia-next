import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import { fn } from "storybook/test"

import { ChatHeader } from "./chat-header"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import type { Character, ChatSession } from "@cognia/agent-config-types"

// Slim chat header: identity + ambient status (live cost, plan-mode tasks,
// no-API-key warning) + the chat.header plugin slot + a settings trigger.
const character: Character = {
  id: "claude",
  name: "Claude",
  description: "Helpful coding assistant",
  avatarColor: "#6366f1",
  systemPrompt: "You are helpful.",
} as Character

const makeAdapter = (char?: Character): DataAdapter => ({
  useCharacters: () => (char ? [char] : []),
  useCharacter: () => char,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
})

const withCharacter = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={makeAdapter(character)}>
    <div className="w-full max-w-3xl border rounded-md">
      <Story />
    </div>
  </DataAdapterProvider>
)

const withoutCharacter = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={makeAdapter(undefined)}>
    <div className="w-full max-w-3xl border rounded-md">
      <Story />
    </div>
  </DataAdapterProvider>
)

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "demo-session",
    title: "Refactor the composer",
    characterId: "claude",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }) as ChatSession

const meta = {
  title: "Chat/ChatHeader",
  component: ChatHeader,
  parameters: { layout: "padded" },
  decorators: [withCharacter],
  // No `onOpenSettings`: the header's settings entry moved into the sheet that
  // already owned it, so `Props` no longer carries the callback.
  args: { session: session() },
  beforeEach: () => resetStore(useChatStore),
} satisfies Meta<typeof ChatHeader>

export default meta
type Story = StoryObj<typeof meta>

/** Identity + settings trigger. */
export const Default: Story = {}

/** An untitled session falls back to a placeholder title. */
export const Untitled: Story = {
  args: { session: session({ title: "" }) },
}

/** No bound character → no avatar / subtitle. */
export const NoCharacter: Story = {
  decorators: [withoutCharacter],
  args: { session: session({ characterId: undefined }) },
}
