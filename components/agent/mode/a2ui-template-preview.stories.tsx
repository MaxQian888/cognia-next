import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UITemplatePreview } from "./a2ui-template-preview"

const meta = {
  title: "Agent/Mode/A2UITemplatePreview",
  component: A2UITemplatePreview,
} satisfies Meta<typeof A2UITemplatePreview>

export default meta
type Story = StoryObj<typeof meta>

const TEMPLATE = {
  id: "tpl-status",
  name: "Status board",
  description: "What the mode paints when it reports back",
  components: [
    {
      component: "Card",
      props: { title: "Status" },
      children: [
        { component: "Text", props: { value: "All systems nominal" } },
        { component: "Button", props: { label: "Refresh", action: "reload" } },
      ],
    },
  ],
  dataModel: {},
}

// No template → dashed empty-state placeholder.
export const Empty: Story = {}

// With a template: component count, the flattened tree, and the raw spec.
export const WithTemplate: Story = {
  args: { template: TEMPLATE },
}

// Collapsed. Only reachable when the caller passes `onTogglePreview` — without
// a handler the card stays open rather than rendering a header over nothing.
export const Collapsed: Story = {
  args: { template: TEMPLATE, showPreview: false, onTogglePreview: () => {} },
}
