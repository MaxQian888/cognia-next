import type { Meta, StoryObj } from "@storybook/nextjs"

import { UnknownPartCard } from "./unknown-part-card"

const meta = {
  title: "Chat/MessageParts/UnknownPartCard",
  component: UnknownPartCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof UnknownPartCard>

export default meta
type Story = StoryObj<typeof meta>

// A custom/unrecognised part — collapsible card naming the type, JSON inside.
export const CustomPart: Story = {
  args: {
    part: {
      type: "x-custom-widget",
      payload: { id: "w1", values: [1, 2, 3], label: "experimental" },
    },
  },
}

// A part with no `type` field falls back to the "unknown" label.
export const NoType: Story = {
  args: {
    part: { foo: "bar", nested: { a: true } },
  },
}
