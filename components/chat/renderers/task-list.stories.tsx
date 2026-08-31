import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskListItem } from "./task-list"

const meta = {
  title: "Chat/Renderers/TaskListItem",
  component: TaskListItem,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <ul className="typeset typeset-chat max-w-prose">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof TaskListItem>

export default meta
type Story = StoryObj<typeof meta>

// `- [ ] …` in an assistant reply.
export const Unchecked: Story = {
  args: { checked: false, children: "Write a failing repro test" },
}

// `- [x] …` — struck through and muted.
export const Checked: Story = {
  args: { checked: true, children: "Research the existing implementation" },
}

// The label wraps under the glyph rather than beside it, so a long item keeps
// its hanging indent.
export const LongLabel: Story = {
  args: {
    checked: false,
    children:
      "Confirm the redaction gate runs before every outbound embedding call, including the connector auto-reply path and the twin distillation job",
  },
}
