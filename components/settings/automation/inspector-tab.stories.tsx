import type { Meta, StoryObj } from "@storybook/nextjs"

import { InspectorTab } from "./inspector-tab"

// Tauri-branching: the app-session Inspector talks to the canonical automation
// core through Rust. Storybook reaches the desktop-runtime-required branch.
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
