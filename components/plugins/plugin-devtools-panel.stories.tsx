import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDevtoolsPanel } from "./plugin-devtools-panel"

// Power-user devtools panel (logs / bus / hooks / profiler / hot-reload /
// inspect / triggers / cli tabs). Gated behind a developer-mode flag in
// localStorage — off by default, so it shows the enable-developer-mode gate.

const DEVELOPER_MODE_KEY = "cognia.plugins.developerMode"

const meta = {
  title: "Plugins/PluginDevtoolsPanel",
  component: PluginDevtoolsPanel,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginDevtoolsPanel>

export default meta
type Story = StoryObj<typeof meta>

// Default: developer mode off → the gate card.
export const Gated: Story = {
  beforeEach: () => {
    window.localStorage.removeItem(DEVELOPER_MODE_KEY)
  },
}

// Developer mode enabled → the full tabbed diagnostics surface.
export const DeveloperMode: Story = {
  beforeEach: () => {
    window.localStorage.setItem(DEVELOPER_MODE_KEY, "true")
    return () => window.localStorage.removeItem(DEVELOPER_MODE_KEY)
  },
}
