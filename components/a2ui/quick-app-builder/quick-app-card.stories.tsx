import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { QuickAppCard } from "./quick-app-card"
import { makeAppInstance, makeAppTemplate } from "@/lib/storybook/fixtures/a2ui"

const meta = {
  title: "A2UI/QuickAppBuilder/QuickAppCard",
  component: QuickAppCard,
  parameters: { layout: "centered" },
  args: {
    app: makeAppInstance(),
    template: makeAppTemplate(),
    isActive: false,
    viewMode: "grid",
    onSelect: fn(),
    onDuplicate: fn(),
    onDownload: fn(),
    onDelete: fn(),
    onCopyToClipboard: fn(async () => true),
    onNativeShare: fn(async () => {}),
    onSocialShare: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[340px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof QuickAppCard>

export default meta
type Story = StoryObj<typeof meta>

export const Grid: Story = {}

export const Active: Story = { args: { isActive: true } }

export const List: Story = { args: { viewMode: "list" } }
