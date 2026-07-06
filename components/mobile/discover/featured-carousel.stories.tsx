import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { FeaturedCarousel } from "./featured-carousel"
import { makeCharacter } from "@/lib/storybook/fixtures/mobile-discover"

// Horizontally scrolling row of "featured" persona tiles. Renders null when
// fewer than 3 characters are eligible, so each story supplies at least 3.
const meta = {
  title: "Mobile/Discover/FeaturedCarousel",
  component: FeaturedCarousel,
  parameters: { layout: "fullscreen" },
  args: { onSelect: fn() },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] py-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FeaturedCarousel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    characters: [
      makeCharacter({ name: "Tutor", avatarEmoji: "🐙" }),
      makeCharacter({ name: "Coach", avatarEmoji: "🏋️" }),
      makeCharacter({ name: "Editor", avatarEmoji: "✒️" }),
      makeCharacter({ name: "Analyst", avatarEmoji: "📊" }),
      makeCharacter({ name: "Planner", avatarEmoji: "🗓️" }),
    ],
  },
}

export const Minimum: Story = {
  args: {
    characters: [
      makeCharacter({ name: "Tutor", avatarEmoji: "🐙" }),
      makeCharacter({ name: "Coach", avatarEmoji: "🏋️" }),
      makeCharacter({ name: "Editor", avatarEmoji: "✒️" }),
    ],
  },
}
