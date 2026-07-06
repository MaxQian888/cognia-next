import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SettingsFinder } from "./settings-finder"

// `SettingsFinder` is a ⌘/Ctrl+K command palette over both settings sections and
// individual controls. It's prop-driven (`open` / `onOpenChange`); selecting an
// item navigates via the (mocked) App Router. Open it to render the populated
// command list.
const meta = {
  title: "Settings/Finder/SettingsFinder",
  component: SettingsFinder,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof SettingsFinder>

export default meta
type Story = StoryObj<typeof meta>

// Open palette listing controls + sections.
export const Open: Story = {}
