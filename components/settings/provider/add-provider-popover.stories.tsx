import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { Button } from "@/components/ui/button"
import { AddProviderPopover } from "./add-provider-popover"

// Quick-add popover for built-in providers. `open` is internal state, so the
// popover starts closed — click the trigger button to reveal the 2×4 provider
// grid (rendered into a portal). All actions are wired to `fn()` so clicks log
// in the Actions panel without side effects.

const meta = {
  title: "Settings/Provider/AddProviderPopover",
  component: AddProviderPopover,
  parameters: { layout: "centered" },
  args: {
    onSelectProvider: fn(),
    onCustomProvider: fn(),
    onOpenWizard: fn(),
    children: <Button>Add provider</Button>,
  },
} satisfies Meta<typeof AddProviderPopover>

export default meta
type Story = StoryObj<typeof meta>

// Click the trigger to open the preset grid; no providers marked configured.
export const Default: Story = {}

// Two presets already configured — shown with the primary-tinted checkmark.
export const WithConfiguredProviders: Story = {
  args: {
    configuredProviderIds: ["openai", "anthropic"],
  },
}
