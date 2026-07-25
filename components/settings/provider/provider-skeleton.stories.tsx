import type { Meta, StoryObj } from "@storybook/nextjs"
import { ProviderSkeleton } from "./provider-skeleton"

// Pure, prop-less loading skeleton for the provider settings page. It mirrors
// the real fill-height master/detail frame, so the decorator has to give it a
// height — in a zero-height box the rail and detail pane collapse to nothing.
const meta = {
  title: "Settings/Provider/ProviderSkeleton",
  component: ProviderSkeleton,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderSkeleton>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
