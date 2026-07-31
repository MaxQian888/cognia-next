import type { Meta, StoryObj } from "@storybook/nextjs"

import { ScreenOffCard } from "./screen-off-card"

// Screen-off Computer Use card. `platform` is a prop; the virtual-display
// health comes from `useVirtualDisplayHealth`, whose Rust probe rejects in the
// Storybook browser, leaving health unavailable → the "Setup required" badge.
// The macOS/Linux story exercises the "Windows-only" note branch instead.
const meta = {
  title: "Settings/Automation/ScreenOffCard",
  component: ScreenOffCard,
  parameters: { layout: "padded" },
  args: { platform: "windows" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScreenOffCard>

export default meta
type Story = StoryObj<typeof meta>

// Windows, no virtual-display driver yet → "Setup required" + setup/probe.
export const Default: Story = {}

// Non-Windows platform → the "Windows-only" note replaces the action buttons.
export const NonWindows: Story = {
  args: { platform: "darwin" },
}
