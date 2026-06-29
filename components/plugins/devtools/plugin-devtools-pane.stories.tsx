import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDevtoolsPane } from "./plugin-devtools-pane"

// Devtools section content — stacks the CLI status card, local-load dropzone,
// manifest validator, hot-reload diagnostics, the devtools panel, and the
// extension-point diagnostics. The host-backed surfaces (CLI status, dropzone,
// hot-reload) render their web/empty branches in this Storybook.

const meta = {
  title: "Plugins/Devtools/PluginDevtoolsPane",
  component: PluginDevtoolsPane,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[720px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDevtoolsPane>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
