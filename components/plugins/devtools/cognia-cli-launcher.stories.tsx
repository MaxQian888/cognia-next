import type { Meta, StoryObj } from "@storybook/nextjs"

import { CogniaCliLauncher } from "./cognia-cli-launcher"

// Launcher control for spawning a `cognia` CLI session from the desktop app.
// Selecting a working directory + launching are host actions; the story renders
// the launcher in its idle state.

const meta = {
  title: "Plugins/Devtools/CogniaCliLauncher",
  component: CogniaCliLauncher,
  parameters: { layout: "centered" },
} satisfies Meta<typeof CogniaCliLauncher>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
