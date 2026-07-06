import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CogniaCliInstallDialog } from "./cognia-cli-install-dialog"

// Controlled dialog that walks the user through installing the `cognia` CLI
// (prebuilt download or build-from-source). The actual install is a desktop
// host action; in this browser Storybook it surfaces the unsupported branch.

const meta = {
  title: "Plugins/Devtools/CogniaCliInstallDialog",
  component: CogniaCliInstallDialog,
  args: { open: true, onOpenChange: fn(), onInstalled: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof CogniaCliInstallDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
