import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ModeSwitcher } from "./mode-switcher"

// `currentMode` drives the badge label; selecting an option persists the
// override (Dexie) and best-effort interrupts the run (Tauri-only). In the
// Storybook web shell the interrupt is a no-op, so the badge + dropdown
// render fully.
const meta = {
  title: "Inbox/ModeSwitcher",
  component: ModeSwitcher,
  args: {
    conversationKey: "slack:a1:C1",
    sessionId: "ses_1",
    currentMode: "auto",
    onModeChange: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ModeSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const Auto: Story = {}

export const Manual: Story = { args: { currentMode: "manual" } }

export const Draft: Story = { args: { currentMode: "draft" } }
