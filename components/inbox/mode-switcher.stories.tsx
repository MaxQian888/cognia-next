import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ModeSwitcher } from "./mode-switcher"

// `selection` drives the badge label. Selecting an option persists the
// override (Dexie, or a relayed write off the desktop) and best-effort
// interrupts the run (Tauri-only). In the Storybook web shell the interrupt is
// a no-op, so the badge + dropdown render fully.
const meta = {
  title: "Inbox/ModeSwitcher",
  component: ModeSwitcher,
  args: {
    conversationKey: "slack:a1:C1",
    sessionId: "ses_1",
    selection: "assistant",
    targetKind: "direct",
    onOpenAdvanced: fn(),
    onSelectionChange: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ModeSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const Assistant: Story = {}

export const Draft: Story = { args: { selection: "draft" } }

export const Silent: Story = { args: { selection: "silent" } }

/** With a team bound, `delegate` becomes selectable and is the current value. */
export const Delegate: Story = { args: { selection: "delegate", targetKind: "team" } }

/**
 * On a direct-target conversation `delegate` has no carrier, so the row is
 * disabled and says why rather than disappearing.
 */
export const DelegateUnavailable: Story = {
  args: { selection: "assistant", targetKind: "direct" },
}

/**
 * Axes that add up to no named preset (a `confirm` autonomy, say). The chip
 * reads out `Custom` and routes to the override dialog instead of inventing a
 * second axis editor.
 */
export const Custom: Story = { args: { selection: "custom" } }
