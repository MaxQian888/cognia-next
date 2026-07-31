import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { GradientBuilder } from "./gradient-builder"

// Builds a 2-stop linear gradient (two colors + angle) and hands the final CSS
// string + name to `onCreate`. `initial` seeds the first render only.
const meta = {
  title: "Settings/Appearance/GradientBuilder",
  component: GradientBuilder,
  parameters: { layout: "padded" },
  args: { onCreate: fn() },
} satisfies Meta<typeof GradientBuilder>

export default meta
type Story = StoryObj<typeof meta>

// Default blue/purple stops.
export const Default: Story = {}

// Seeded with a warm sunset gradient.
export const Seeded: Story = {
  args: { initial: { start: "#ff7e5f", end: "#feb47b", angle: 90 } },
}
