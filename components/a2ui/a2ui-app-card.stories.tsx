import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AppCard } from "./a2ui-app-card"
import { makeAppInstance, makeAppTemplate } from "@/lib/storybook/fixtures/a2ui"

const meta = {
  title: "A2UI/AppCard",
  component: AppCard,
  parameters: { layout: "centered" },
  args: {
    app: makeAppInstance(),
    template: makeAppTemplate(),
    onSelect: fn(),
    onOpen: fn(),
    onRename: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onReset: fn(),
    onViewDetails: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Selected: Story = { args: { isSelected: true } }

export const Compact: Story = { args: { compact: true } }

export const NoThumbnail: Story = { args: { showThumbnail: false } }

export const WithoutStats: Story = {
  args: { app: makeAppInstance({ stats: undefined }), showStats: false },
}
