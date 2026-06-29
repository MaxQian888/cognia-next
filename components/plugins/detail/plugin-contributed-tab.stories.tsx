import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginContributedTab } from "./plugin-contributed-tab"

// Runtime contributions registry view — lists everything a plugin has actually
// registered with the live PluginManager (tools, modes, commands, A2UI
// components/templates, themes, MCP presets, skills, native tools, external
// agent presets, workflow triggers/nodes). In Storybook the registry is empty,
// so this renders the no-contributions empty state — the chrome this story
// covers.

const meta = {
  title: "Plugins/Detail/PluginContributedTab",
  component: PluginContributedTab,
  args: { pluginId: "com.acme.web-tools" },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginContributedTab>

export default meta
type Story = StoryObj<typeof meta>

// Empty registry → no-contributions empty state.
export const Empty: Story = {}
