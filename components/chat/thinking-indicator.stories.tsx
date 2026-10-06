import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { ChatThinkingIndicator } from "./thinking-indicator"
import type { Character } from "@cognia/agent-config-types"

// The indicator is phase-driven by timers: one shimmering status word that
// cycles every 3s, then (≥8s) a rotating tip line. Leave a story open a few
// seconds to watch it advance.
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

// How the tail of a running turn looks once a tool block / streamed text is
// already on screen: same live label + tips, no avatar, aligned with the reply.
export const Compact: Story = {
  args: { compact: true },
}
