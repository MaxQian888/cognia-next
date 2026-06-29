import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LongPress } from "./long-press"

// Wraps a child and fires `onLongPress` after a hold. Press and hold the card
// to trigger it (check the Actions panel).
const meta = {
  title: "Interactions/LongPress",
  component: LongPress,
  args: { onLongPress: fn(), silent: true },
  parameters: { layout: "centered" },
} satisfies Meta<typeof LongPress>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: (
      <div className="flex h-20 w-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        Press and hold me
      </div>
    ),
  },
}

export const FastTrigger: Story = {
  args: {
    delayMs: 200,
    children: (
      <div className="flex h-20 w-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        Hold (200ms)
      </div>
    ),
  },
}
