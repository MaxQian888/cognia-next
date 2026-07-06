import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { StorageCleanupDialog } from "./storage-cleanup-dialog"
import { seedDb } from "@/lib/storybook/seed-db"

const formatBytes = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`

// 3-tab cleanup dialog (Quick / Custom preview-then-confirm / Deep), backed by
// `useStorageCleanup`. Closed by default — the trigger button renders; opening
// it lists the selectable categories.
const meta = {
  title: "Data/StorageCleanupDialog",
  component: StorageCleanupDialog,
  args: { formatBytes, onCleanupComplete: fn() },
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
} satisfies Meta<typeof StorageCleanupDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
