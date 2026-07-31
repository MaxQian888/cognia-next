import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StorageCleanupSheet } from "./storage-cleanup-sheet"

// Bottom-sheet with the Quick / Deep cleanup presets. Controlled via `open`;
// the cleanup actions come from `useStorageCleanup` (no-op data layer in the
// Storybook browser). Rendered open so the presets are visible.
const meta = {
  title: "Mobile/Me/StorageCleanupSheet",
  component: StorageCleanupSheet,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onCleaned: fn(),
  },
} satisfies Meta<typeof StorageCleanupSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Closed: Story = {
  args: { open: false },
}
