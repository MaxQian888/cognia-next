import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UITemplatePreview } from "./a2ui-template-preview"

const meta = {
  title: "Agent/Mode/A2UITemplatePreview",
  component: A2UITemplatePreview,
} satisfies Meta<typeof A2UITemplatePreview>

export default meta
type Story = StoryObj<typeof meta>

// No template → dashed empty-state placeholder.
export const Empty: Story = {}

// A template object renders as a pretty-printed JSON dump.
export const WithTemplate: Story = {
  args: {
    template: {
      type: "Card",
      props: { title: "Status" },
      children: [
        { type: "Text", props: { value: "All systems nominal" } },
        { type: "Button", props: { label: "Refresh", action: "reload" } },
      ],
    },
  },
}
