import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginCapabilitiesSection } from "./plugin-capabilities-section"

// Lists workflow capabilities contributed by installed plugins (custom
// nodes/triggers + templates), read from the plugin catalog + template
// registry. With no plugins registered in the Storybook runtime it renders the
// empty-state message — the realistic default when no plugins contribute
// workflow nodes.
const meta = {
  title: "Workflow/Editor/Settings/PluginCapabilitiesSection",
  component: PluginCapabilitiesSection,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[360px]">{Story()}</div>],
} satisfies Meta<typeof PluginCapabilitiesSection>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
