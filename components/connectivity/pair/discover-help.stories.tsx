import type { Meta, StoryObj } from "@storybook/nextjs"

import { DiscoverHelp } from "./discover-help"

// "Can't find your desktop?" troubleshooting collapsible. Pure: the only prop
// that changes rendering is `emphasised`, which auto-expands the panel and
// switches the framing from dashed to solid (used when a scan found nothing).
const meta = {
  title: "Mobile/Pair/DiscoverHelp",
  component: DiscoverHelp,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiscoverHelp>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed dashed helper — the steady state alongside a populated list. */
export const Collapsed: Story = {}

/** Auto-expanded + solid framing, as shown when the scan settled with nothing. */
export const Emphasised: Story = {
  args: { emphasised: true },
}
