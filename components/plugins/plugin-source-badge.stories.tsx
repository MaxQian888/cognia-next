import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginSourceBadge } from "./plugin-source-badge"
import type { PluginSource } from "@/types/plugin"

// Only these sources have labels in plugins.source.*; `git` is intentionally omitted.
const SOURCES: PluginSource[] = ["builtin", "local", "marketplace", "git", "dev"]

const meta = {
  title: "Plugins/PluginSourceBadge",
  component: PluginSourceBadge,
  args: { source: "builtin" },
} satisfies Meta<typeof PluginSourceBadge>

export default meta
type Story = StoryObj<typeof meta>

export const BuiltIn: Story = {}

export const AllSources: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {SOURCES.map((s) => (
        <PluginSourceBadge key={s} source={s} />
      ))}
    </div>
  ),
}

/** A dev build standing in front of the installed marketplace copy. */
export const ShadowingAnInstalledBuild: Story = {
  render: () => <PluginSourceBadge source="dev" observedSources={["marketplace", "dev"]} />,
}
