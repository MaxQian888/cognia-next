import type { Meta, StoryObj } from "@storybook/nextjs"

import { CalibrationPanel } from "./calibration-panel"

// Judge calibration loop (eval spec §10). Propless — reads the settings store
// and Dexie calibration tables. With an empty DB it renders the new-set form,
// the set picker, and the "no run" / "empty items" states.
const meta = {
  title: "Eval/CalibrationPanel",
  component: CalibrationPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CalibrationPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
