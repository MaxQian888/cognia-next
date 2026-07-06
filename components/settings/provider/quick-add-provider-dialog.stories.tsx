import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { QuickAddProviderDialog } from "./quick-add-provider-dialog"

// Preset-driven quick-add dialog for OpenAI-compatible providers. It reads the
// `addCustomProvider` action from the settings store (invoked only on Save), so
// we reset the store before each render to keep the action wired to a clean
// initial state. The preset catalog comes from the built-in provider catalog —
// no network or sidecar at render. The "Test" button hits a real API only on
// click; the initial selection view is inert.

const meta = {
  title: "Settings/Provider/QuickAddProviderDialog",
  component: QuickAddProviderDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  args: {
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof QuickAddProviderDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open on the provider-selection view (search + category tabs + preset grid).
export const Open: Story = {}

// Closed — nothing renders into the portal.
export const Closed: Story = {
  args: {
    open: false,
  },
}
