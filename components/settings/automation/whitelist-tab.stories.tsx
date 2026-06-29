import type { Meta, StoryObj } from "@storybook/nextjs"

import { WhitelistTab } from "./whitelist-tab"

// Tauri-branching: desktop automation persists through the Rust gate. In the
// Storybook browser (`isTauri()` is false) the tab returns its "requires the
// Tauri runtime" alert before the process-name / window-title editors — the
// reachable web branch.
const meta = {
  title: "Settings/Automation/WhitelistTab",
  component: WhitelistTab,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WhitelistTab>

export default meta
type Story = StoryObj<typeof meta>

// Web branch — desktop-runtime-required alert.
export const Default: Story = {}
