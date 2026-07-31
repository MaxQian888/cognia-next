import type { Meta, StoryObj } from "@storybook/nextjs"

import { BarCustomizer } from "./bar-customizer"

// Two-bucket editor ("In the bar" / "Hidden") for one window bar. It reads and
// writes the settings store directly, so both stories exercise the real
// reorder / hide / show / reset surface.
const meta = {
  title: "Shell/BarCustomizer",
  component: BarCustomizer,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BarCustomizer>

export default meta
type Story = StoryObj<typeof meta>

export const TopBar: Story = { args: { bar: "title" } }
export const BottomBar: Story = { args: { bar: "status" } }
