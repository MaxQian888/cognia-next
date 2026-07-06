import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PermissionModeIndicator } from "./permission-mode-indicator"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore, type PermissionMode } from "@/stores/chat"

// Status pill at the bottom of the composer showing the active permission mode.
// Clicking cycles default → acceptEdits → plan → bypassPermissions. The mode is
// read from the chat store, so each story seeds it.
const seedMode = (mode: PermissionMode | null) => () => {
  resetStore(useChatStore)
  useChatStore.getState().setPermissionMode(mode)
}

const meta = {
  title: "Chat/PermissionModeIndicator",
  component: PermissionModeIndicator,
  parameters: { layout: "centered" },
  args: { onCycle: fn() },
  beforeEach: seedMode(null),
} satisfies Meta<typeof PermissionModeIndicator>

export default meta
type Story = StoryObj<typeof meta>

/** Default mode (no escalation). */
export const Default: Story = {}

export const AcceptEdits: Story = { beforeEach: seedMode("acceptEdits") }

export const PlanMode: Story = { beforeEach: seedMode("plan") }

export const BypassPermissions: Story = { beforeEach: seedMode("bypassPermissions") }

/** Disabled while a turn streams. */
export const Disabled: Story = {
  args: { disabled: true },
  beforeEach: seedMode("acceptEdits"),
}
