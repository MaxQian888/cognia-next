import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CharacterPicker } from "./character-picker"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { Character } from "@/lib/claude/types"

// The picker is a CommandDialog (open via the `open` prop) that lists every
// resolvable character grouped into Built-in / per-plugin / user buckets. It
// reads `useCharacters()` through the data-adapter context (the real one is
// mounted in app/layout.tsx), so each story supplies a mock adapter with a
// fixed roster — no Dexie / sidecar.

const char = (id: string, name: string, extra: Partial<Character> = {}): Character => ({
  ...extra,
  id,
  name,
  avatarColor: "oklch(0.62 0.17 250)",
  systemPrompt: `You are ${name}.`,
  createdAt: 0,
  updatedAt: 0,
})

const roster: Character[] = [
  char("claude", "Claude", {
    description: "The default general-purpose assistant",
    avatarEmoji: "✨",
    isBuiltIn: true,
  }),
  char("researcher", "Researcher", {
    description: "Deep, cited multi-source research",
    avatarEmoji: "🔬",
    isBuiltIn: true,
  }),
  // Plugin-contributed (overlay synthetic id → grouped under its plugin).
  char("cognia-pack:acme-personas:team:pm", "Priya the PM", {
    description: "Crisp product specs and trade-off calls",
    avatarEmoji: "📋",
    sourcePluginId: "acme-personas",
  }),
  // Locally-imported pack file.
  char("cognia-pack:local:imported:mentor", "Code Mentor", {
    description: "Patient, explains the why behind every change",
    avatarEmoji: "🎓",
    sourcePluginId: "local:imported",
  }),
  // User-created (plain Dexie id).
  char("user-1", "My Translator", {
    description: "EN ⇄ 中文, keeps tone and idiom",
    avatarEmoji: "🌐",
  }),
]

const makeAdapter = (characters: Character[]): DataAdapter => ({
  useCharacters: () => characters,
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
})

const rosterAdapter = makeAdapter(roster)
const emptyAdapter = makeAdapter([])

const withRoster = (Story: () => React.ReactElement) => (
  <DataAdapterProvider adapter={rosterAdapter}>
    <Story />
  </DataAdapterProvider>
)

const withEmpty = (Story: () => React.ReactElement) => (
  <DataAdapterProvider adapter={emptyAdapter}>
    <Story />
  </DataAdapterProvider>
)

const meta = {
  title: "Chat/CharacterPicker",
  component: CharacterPicker,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onPick: fn(),
  },
} satisfies Meta<typeof CharacterPicker>

export default meta
type Story = StoryObj<typeof meta>

// Full roster — built-in, plugin, local-file, and user-created groups.
export const FullRoster: Story = {
  decorators: [withRoster],
}

// No characters resolve — the command-empty state.
export const Empty: Story = {
  decorators: [withEmpty],
}
