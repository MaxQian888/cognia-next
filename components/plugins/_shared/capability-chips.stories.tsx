import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { CapabilityChips } from "./capability-chips"

// Capability chip group summarizing a plugin's `capabilities[]` array. Honors a
// `limit` (default 3) with an "+N more" overflow badge that, when `hoverable`,
// opens a HoverCard listing the full set. Stories cover empty (renders null),
// under-limit, over-limit hoverable, over-limit static, and the secondary
// variant.

const meta = {
  title: "Plugins/Shared/CapabilityChips",
  component: CapabilityChips,
  args: { capabilities: ["tools", "commands", "modes"] },
  decorators: [
    (Story) => (
      <div className="w-[320px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CapabilityChips>

export default meta
type Story = StoryObj<typeof meta>

// At or under the limit — every chip shown, no overflow badge.
export const UnderLimit: Story = {}

// Empty array → component renders nothing.
export const Empty: Story = { args: { capabilities: [] } }

// Above the limit with a hoverable overflow badge (hover "+N more").
export const OverflowHoverable: Story = {
  args: {
    capabilities: ["tools", "commands", "modes", "themes", "mcp", "hooks"],
    limit: 3,
    hoverable: true,
  },
}

// Above the limit with a static overflow badge (no HoverCard).
export const OverflowStatic: Story = {
  args: {
    capabilities: ["tools", "commands", "modes", "themes", "mcp"],
    limit: 3,
    hoverable: false,
  },
}

// Secondary chip variant.
export const SecondaryVariant: Story = {
  args: {
    capabilities: ["tools", "commands", "modes", "themes"],
    limit: 2,
    variant: "secondary",
  },
}
