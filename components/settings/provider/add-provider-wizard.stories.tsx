import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AddProviderWizard } from "./add-provider-wizard"

// 4-step guided "add provider" dialog. With `open: true` it renders into a
// portal on step 1 (provider grid). Passing `initialProviderId` jumps straight
// to step 2 (credentials). Model loading + the connection test are simulated on
// internal timers triggered by user navigation, so the initial render is inert.

const meta = {
  title: "Settings/Provider/AddProviderWizard",
  component: AddProviderWizard,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onComplete: fn(),
  },
} satisfies Meta<typeof AddProviderWizard>

export default meta
type Story = StoryObj<typeof meta>

// Step 1 — provider selection grid with search.
export const SelectProviderStep: Story = {}

// Pre-selecting a provider opens directly on step 2 (credentials).
export const PrefilledCredentialsStep: Story = {
  args: {
    initialProviderId: "openai",
  },
}

// Closed — nothing renders into the portal.
export const Closed: Story = {
  args: {
    open: false,
  },
}
