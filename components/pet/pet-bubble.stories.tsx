import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetBubbleView } from "./pet-bubble"

// The pet's speech bubble. Presentational — text + origin come from the store;
// `null` renders nothing.
const meta = {
  title: "Pet/Bubble",
  component: PetBubbleView,
  parameters: { layout: "centered" },
  args: { bubble: { text: "Looks like that test is finally green.", origin: "llm" } },
} satisfies Meta<typeof PetBubbleView>

export default meta
type Story = StoryObj<typeof meta>

export const Llm: Story = {}

export const Template: Story = {
  args: { bubble: { text: "Beep boop. Hi!", origin: "template" } },
}

export const System: Story = {
  args: { bubble: { text: "Your pet just reached level 8!", origin: "system" } },
}

export const Hidden: Story = {
  args: { bubble: null },
}
