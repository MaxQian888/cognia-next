import type { Meta, StoryObj } from "@storybook/nextjs"

import { ComputerUseChip } from "./computer-use-chip"

// Pure presentational chip — surfaces the per-conversation `allowComputerUse`
// flag. Renders nothing when `active` is false, so that branch is wrapped to
// keep the empty result visible in the panel.
const meta = {
  title: "Inbox/ComputerUseChip",
  component: ComputerUseChip,
  args: { active: true },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ComputerUseChip>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {}

export const Inactive: Story = {
  args: { active: false },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <ComputerUseChip {...args} />
    </div>
  ),
}
