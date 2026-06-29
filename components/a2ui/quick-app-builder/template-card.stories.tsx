import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TemplateCard } from "./template-card"
import { makeAppTemplate } from "@/lib/storybook/fixtures/a2ui"

const meta = {
  title: "A2UI/QuickAppBuilder/TemplateCard",
  component: TemplateCard,
  parameters: { layout: "centered" },
  args: {
    template: makeAppTemplate(),
    viewMode: "grid",
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplateCard>

export default meta
type Story = StoryObj<typeof meta>

export const Grid: Story = {}

export const List: Story = { args: { viewMode: "list" } }

export const ManyTags: Story = {
  args: {
    template: makeAppTemplate({ tags: ["finance", "math", "charts", "tools", "utility"] }),
  },
}
