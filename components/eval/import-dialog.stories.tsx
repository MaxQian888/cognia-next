import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ImportDialog } from "./import-dialog"

// Multi-source dataset import (File / HuggingFace / History / Foreign). The
// History tab reads recent traces from Dexie (empty in Storybook → its empty
// state). Source tabs are plain segmented buttons.
const meta = {
  title: "Eval/ImportDialog",
  component: ImportDialog,
  parameters: { layout: "padded" },
  args: { datasetId: "ds-1", capability: "chat.tool-use", onClose: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ImportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
