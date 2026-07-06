import type { Meta, StoryObj } from "@storybook/nextjs"
import { ProviderSkeleton } from "./provider-skeleton"

// Pure, prop-less loading skeleton for the provider settings page.
const meta = {
  title: "Settings/Provider/ProviderSkeleton",
  component: ProviderSkeleton,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderSkeleton>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
