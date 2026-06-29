import type { Meta, StoryObj } from "@storybook/nextjs"

import { InspectorTab } from "./inspector-tab"

// Tauri-branching: the UIA tree inspector talks to the active accessibility
// backend through Rust. In the Storybook browser (`isTauri()` is false) the tab
// returns its "requires the Tauri runtime" alert before the tree / details
// panes — the reachable web branch.
const meta = {
  title: "Settings/Automation/InspectorTab",
  component: InspectorTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[840px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InspectorTab>

export default meta
type Story = StoryObj<typeof meta>

// Web branch — desktop-runtime-required alert.
export const Default: Story = {}
