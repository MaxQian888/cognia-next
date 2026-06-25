import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChatHeaderPresetPill } from "./chat-header-preset-pill"
import type { ChatSession, SystemPromptPreset } from "@/lib/claude/types"

// Fully props-driven header pill. Renders the active-preset badge; clicking it
// opens a searchable grouped Popover (favorites / recent / category). Stories
// seed realistic presets and select a session preset id to drive the label.

const now = 1_700_000_000_000

const preset = (
  id: string,
  name: string,
  extra: Partial<SystemPromptPreset> = {}
): SystemPromptPreset => ({
  id,
  name,
  content: `You are ${name}.`,
  createdAt: now,
  updatedAt: now,
  ...extra,
})

const presets: SystemPromptPreset[] = [
  preset("p-coder", "Senior Engineer", {
    description: "Terse, code-first answers with tests",
    icon: "🛠️",
    color: "oklch(0.62 0.17 250)",
    category: "coding",
    isFavorite: true,
  }),
  preset("p-writer", "Technical Writer", {
    description: "Clear prose, docs, and changelogs",
    icon: "✍️",
    color: "oklch(0.7 0.14 150)",
    category: "writing",
  }),
  preset("p-default", "Default Assistant", {
    description: "General-purpose helper",
    isDefault: true,
    category: "general",
  }),
]

const session: Pick<ChatSession, "activePresetId" | "systemPrompt"> = {
  activePresetId: "p-coder",
  systemPrompt: "You are Senior Engineer.",
}

const meta = {
  title: "Chat/ChatHeaderPresetPill",
  component: ChatHeaderPresetPill,
  parameters: { layout: "centered" },
  args: {
    session,
    presets,
    onSelectPreset: fn(),
  },
} satisfies Meta<typeof ChatHeaderPresetPill>

export default meta
type Story = StoryObj<typeof meta>

// An active preset is resolved — the pill shows its name; click to open the list.
export const WithActivePreset: Story = {}

// No preset bound to the session — the pill shows the "none" placeholder.
export const NoActivePreset: Story = {
  args: {
    session: { activePresetId: undefined, systemPrompt: "" },
  },
}
