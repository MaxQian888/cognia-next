import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDataManagement } from "./plugin-data-management"

// `PluginDataManagement`'s sole prop is optional with a default arg, which makes
// Storybook infer story args as `never`; type the story against the prop shape.
type PluginDataManagementProps = { pluginId?: string }

// `PluginDataManagement` lists plugins that have declared Dexie tables (rows in
// `pluginDexieMeta`) and offers a per-plugin "delete data" action. It reads the
// table via `useLiveQuery`; with an empty Storybook IndexedDB there are no
// registrations, so it renders the empty-state card — different copy for the
// global (no prop) vs single-plugin (`pluginId`) modes.
const meta = {
  title: "Settings/Plugins/PluginDataManagement",
  component: PluginDataManagement,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<PluginDataManagementProps>

export default meta
type Story = StoryObj<PluginDataManagementProps>

// Global maintenance surface — empty "no plugins store data" card.
export const Default: Story = {}

// Single-plugin mode (inside a plugin detail Sheet) — empty card scoped to one
// plugin id that has not declared any Dexie tables.
export const SinglePlugin: Story = {
  args: { pluginId: "clipboard-history" },
}
