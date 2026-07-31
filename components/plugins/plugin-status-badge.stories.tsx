import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginStatusPill, PluginRuntimeWarnings } from "./plugin-status-badge"
import type { PluginRow } from "@/lib/db/plugin-types"

const meta = {
  title: "Plugins/PluginStatusPill",
  component: PluginStatusPill,
  args: { status: "active", enabled: true },
} satisfies Meta<typeof PluginStatusPill>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {}
export const Disabled: Story = { args: { enabled: false } }
export const Loading: Story = { args: { loading: true } }
export const Suspended: Story = { args: { status: "suspended" } }
export const Error: Story = { args: { status: "error" } }

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <PluginStatusPill status="active" enabled />
      <PluginStatusPill status="active" enabled={false} />
      <PluginStatusPill status="active" enabled loading />
      <PluginStatusPill status="suspended" enabled />
      <PluginStatusPill status="error" enabled />
    </div>
  ),
}

// PluginRuntimeWarnings: renders an amber chip per `_cogniaWarnings` marker.
const withWarnings = (codes: string[]): Pick<PluginRow, "manifest"> => ({
  manifest: { _cogniaWarnings: codes } as PluginRow["manifest"],
})

export const RuntimeWarnings: Story = {
  render: () => <PluginRuntimeWarnings plugin={withWarnings(["python-runtime-unavailable"])} />,
}
