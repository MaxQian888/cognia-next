import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactNode } from "react"
import { fn } from "storybook/test"

import { SessionSettingsSheet } from "./session-settings-sheet"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import type { Character, ChatSession, Skill } from "@cognia/agent-config-types"

// Consolidated "⚙ Session" sheet: low-frequency, session-scoped settings +
// lifecycle actions. Controlled via open / onOpenChange.
const character: Character = {
  id: "claude",
  name: "Claude",
  avatarColor: "#6366f1",
  systemPrompt: "You are helpful.",
  skillIds: ["sk-1"],
} as Character

const skills: Skill[] = [
  { id: "sk-1", name: "Release Notes", description: "Summarize merged PRs." } as Skill,
]

const adapter: DataAdapter = {
  useCharacters: () => [character],
  useCharacter: () => character,
  useSkillsByIds: () => skills,
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withAdapter = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={adapter}>
    <Story />
  </DataAdapterProvider>
)

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "demo-session",
    title: "Refactor the composer",
    characterId: "claude",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    model: "claude-sonnet-4",
    workingDir: "/repo",
    ...over,
  }) as ChatSession

const meta = {
  title: "Chat/SessionSettingsSheet",
  component: SessionSettingsSheet,
  parameters: { layout: "fullscreen" },
  decorators: [withAdapter],
  args: { session: session(), open: true, onOpenChange: fn() },
  beforeEach: () => resetStore(useChatStore),
} satisfies Meta<typeof SessionSettingsSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Open sheet with model / system prompt / working dir form. */
export const Open: Story = {}

/** Mobile variant — also renders the ambient status cluster at the top. */
export const WithAmbientStatus: Story = {
  args: { showAmbientStatus: true },
}

/** Closed — not visible. */
export const Closed: Story = {
  args: { open: false },
}
