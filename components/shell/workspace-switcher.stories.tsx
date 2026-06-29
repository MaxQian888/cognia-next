import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceSwitcher } from "./workspace-switcher"

// Rail entry point for the active workspace. Propless — reads the project
// store. With no projects the trigger shows the folder icon; the popover (list
// + create/manage actions) opens on click.
const meta = {
  title: "Shell/WorkspaceSwitcher",
  component: WorkspaceSwitcher,
  parameters: { layout: "centered" },
} satisfies Meta<typeof WorkspaceSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
