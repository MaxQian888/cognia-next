import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TemplateScopeControl } from "./template-scope-control"

// The ownership half of template scope (ADR-0164): one workspace, or every
// workspace. Rendered for every definition and disabled with the reason when it
// cannot move, so "shared by construction" and "yours to decide" never collapse
// into the same blank space.
const meta = {
  title: "Templates/TemplateScopeControl",
  component: TemplateScopeControl,
  parameters: { layout: "padded" },
  args: {
    tier: "mine",
    activeWorkspaceId: "ws-product",
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[320px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplateScopeControl>

export default meta
type Story = StoryObj<typeof meta>

/** A user-owned definition that is visible everywhere. */
export const Shared: Story = {}

/** The same definition after it was confined to the active workspace. */
export const ConfinedToWorkspace: Story = {
  args: { tier: "workspace", ownerWorkspaceId: "ws-product" },
}

/** Built-in, plugin and marketplace rows are catalog overlays, not local rows. */
export const BlockedSharedSource: Story = {
  args: { tier: "builtin" },
}

/** The project store has not hydrated yet, so there is nothing to confine to. */
export const BlockedNoWorkspace: Story = {
  args: { activeWorkspaceId: null },
}

/** A write is in flight: visible, but not taking taps. */
export const Busy: Story = {
  args: { busy: true },
}
