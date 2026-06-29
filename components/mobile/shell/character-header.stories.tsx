import type { Meta, StoryObj } from "@storybook/nextjs"

import { CharacterHeader } from "./character-header"

// Mobile chat-shell header: avatar + name + optional streaming dot. Props-only;
// when `subject` is null it falls back to a bare title.
const meta = {
  title: "Mobile/Shell/CharacterHeader",
  component: CharacterHeader,
  parameters: { layout: "padded" },
  args: {
    fallbackTitle: "cognia",
  },
  decorators: [
    (Story) => (
      <div className="flex w-[360px] items-center border-b px-3 py-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CharacterHeader>

export default meta
type Story = StoryObj<typeof meta>

export const FallbackTitle: Story = {}

export const WithCharacter: Story = {
  args: {
    subject: { name: "Ada Lovelace", avatarColor: "oklch(0.7 0.14 280)" },
  },
}

export const WithEmoji: Story = {
  args: {
    subject: { name: "Research Bot", avatarEmoji: "🔬" },
  },
}

export const Streaming: Story = {
  args: {
    subject: { name: "Ada Lovelace" },
    streaming: true,
  },
}
