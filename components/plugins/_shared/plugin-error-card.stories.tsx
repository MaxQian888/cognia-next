import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { PluginErrorCard } from "./plugin-error-card"

// Shared error-state card for plugin surfaces (marketplace fetch failure,
// library load error, GitHub install failure). Stories cover the default
// title, a custom title, the with/without-retry split, and a long message
// to confirm the centered max-width wrapping.

const meta = {
  title: "Plugins/Shared/PluginErrorCard",
  component: PluginErrorCard,
  args: { message: "Network unreachable — check your connection and try again." },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginErrorCard>

export default meta
type Story = StoryObj<typeof meta>

// Default i18n title (plugins.shared.errorTitle), no retry affordance.
export const Default: Story = {}

// Retry button rendered when onRetry is supplied.
export const WithRetry: Story = {
  args: { onRetry: fn() },
}

// Call-site-supplied title overriding the shared default.
export const CustomTitle: Story = {
  args: {
    title: "Marketplace offline",
    message: "We couldn't reach the plugin registry.",
    onRetry: fn(),
  },
}

// A long failure message to verify the max-w-sm centered wrapping.
export const LongMessage: Story = {
  args: {
    title: "Failed to load runtime",
    message:
      "The plugin requires a Python interpreter that could not be located on this host. Install Python 3.11+ and restart the app, then retry the installation.",
    onRetry: fn(),
  },
}
