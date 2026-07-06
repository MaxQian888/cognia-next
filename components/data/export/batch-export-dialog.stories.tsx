import type { Meta, StoryObj } from "@storybook/nextjs"

import { BatchExportDialog } from "./batch-export-dialog"
import { Button } from "@/components/ui/button"
import { seedDb } from "@/lib/storybook/seed-db"

// Multi-session batch exporter. Uses its own internal open state, so it needs a
// trigger; clicking it opens the dialog with the session selector.
const meta = {
  title: "Data/BatchExportDialog",
  component: BatchExportDialog,
  args: { trigger: <Button variant="outline">Batch export</Button> },
  parameters: { layout: "padded" },
  beforeEach: async () => {
    await seedDb(async () => {})
  },
} satisfies Meta<typeof BatchExportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
