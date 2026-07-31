import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CharacterCard } from "./character-card"
import { makeCharacter } from "@/lib/storybook/fixtures/mobile-discover"

// Compact character row for the Discover tab. Pure: render as a plain row, a
// link (tap → chat picker), or an onSelect button. Badges surface built-in /
// plugin provenance.
const meta = {
  title: "Mobile/Discover/CharacterCard",
  component: CharacterCard,
  parameters: { layout: "padded" },
  args: { character: makeCharacter() },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CharacterCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const AsButton: Story = {
  args: { onSelect: fn() },
}

export const AsLink: Story = {
  args: { href: "/chat?characterId=char-1" },
}

export const BuiltInAndPlugin: Story = {
  args: {
    character: makeCharacter({
      name: "Octopus Tutor",
      isBuiltIn: true,
      sourcePluginId: "edu-pack",
    }),
  },
}

export const InitialsFallback: Story = {
  args: {
    character: makeCharacter({ name: "Alice Researcher", avatarEmoji: undefined, description: undefined }),
  },
}
