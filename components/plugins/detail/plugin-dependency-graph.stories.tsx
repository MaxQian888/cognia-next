import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDependencyGraph } from "./plugin-dependency-graph"

// Dependency-tree visualization for the Data sub-tab. Resolves the plugin's
// declared dependencies against the installed set (a Dexie read — empty in this
// Storybook), so any declared dependency resolves as unresolved/missing and the
// "unresolved" badge appears. A manifest with no dependencies resolves cleanly.

const meta = {
  title: "Plugins/Detail/PluginDependencyGraph",
  component: PluginDependencyGraph,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDependencyGraph>

export default meta
type Story = StoryObj<typeof meta>

// Declared dependencies that aren't installed → unresolved tree.
export const WithDependencies: Story = {
  args: {
    manifest: {
      id: "com.acme.web-tools",
      dependencies: { "com.cognia.core": "^1.0.0", "com.acme.shared-ui": "~2.3.0" },
    },
  },
}

// No declared dependencies → a clean root-only tree.
export const NoDependencies: Story = {
  args: {
    manifest: { id: "com.acme.tiny" },
  },
}
