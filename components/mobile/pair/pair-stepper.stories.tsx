import type { Meta, StoryObj } from "@storybook/nextjs"

import { PairStepper } from "./pair-stepper"

// Three-step progress rail (discover → pair → paired). Pure: `current` drives
// the done / current / todo state of each pip.
const meta = {
  title: "Mobile/Pair/PairStepper",
  component: PairStepper,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PairStepper>

export default meta
type Story = StoryObj<typeof meta>

export const Discover: Story = { args: { current: "discover" } }
export const Pair: Story = { args: { current: "pair" } }
export const Paired: Story = { args: { current: "paired" } }
