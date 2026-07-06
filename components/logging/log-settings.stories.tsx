import type { Meta, StoryObj } from "@storybook/nextjs"

import { LogSettings } from "./log-settings"

// Propless settings panel — self-bootstraps from the localStorage-backed logger
// config (`getLoggingBootstrapState`) and the transport-health hook. In the
// browser shell the native (Rust) sections stay inactive. Tabs: Levels,
// Transports, Advanced, Retention.
const meta = {
  title: "Logging/LogSettings",
  component: LogSettings,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
