import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { BuiltinToolsToggles } from "./builtin-tools-toggles"

// Per-task overrides for the five built-in tool groups. Each row is a tri-state
// select: "use default" (key absent), "force on" (true), "force off" (false).
const meta = {
  title: "Scheduler/PayloadEditors/BuiltinToolsToggles",
  component: BuiltinToolsToggles,
  parameters: { layout: "padded" },
  args: {
    onChange: fn(),
    testId: "builtin-tools",
  },
} satisfies Meta<typeof BuiltinToolsToggles>

export default meta
type Story = StoryObj<typeof meta>

// Nothing overridden → every row reads "use default".
export const AllDefault: Story = {
  args: { value: undefined },
}

// A mix of forced-on / forced-off / default values across the rows.
export const Mixed: Story = {
  args: {
    value: { fileExtras: true, git: true, process: false, shellAdvanced: false },
  },
}

// Every group explicitly enabled.
export const AllForcedOn: Story = {
  args: {
    value: {
      fileExtras: true,
      git: true,
      process: true,
      environment: true,
      shellAdvanced: true,
    },
  },
}

// Disabled (read-only) — selects can't be changed.
export const Disabled: Story = {
  args: {
    value: { git: true, process: false },
    disabled: true,
  },
}
