import type { Meta, StoryObj } from "@storybook/nextjs"

import { FullRestoreDialog } from "./full-restore-dialog"

// End-to-end import card: file picker → encryption-aware decrypt → preview →
// merge-strategy → apply → summary. Propless; composes the import-flow hook
// with the preview/summary atoms. Renders its idle (pre-file) state here.
const meta = {
  title: "Data/FullRestoreDialog",
  component: FullRestoreDialog,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[32rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FullRestoreDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
