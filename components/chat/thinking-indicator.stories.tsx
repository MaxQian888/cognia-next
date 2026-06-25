import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ChatThinkingIndicator } from "./thinking-indicator"
import type { Character } from "@/lib/claude/types"

// The indicator is phase-driven by timers: avatar pulse → (≥3s) skeleton →
// (≥4s) rotating tip. Leave a story open a few seconds to watch it advance.
const character = {
  id: "char_1",
  name: "Ada",
} as Character

const meta = {
  title: "Chat/ChatThinkingIndicator",
  component: ChatThinkingIndicator,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ChatThinkingIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithDirectCharacter: Story = {
  args: { directCharacter: character },
}
