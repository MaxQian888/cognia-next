import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { FlashAppTab } from "./flash-app-tab"

const meta = {
  title: "A2UI/QuickAppBuilder/FlashAppTab",
  component: FlashAppTab,
  parameters: { layout: "fullscreen" },
  args: {
    onGenerate: fn(async () => {}),
  },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FlashAppTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
