import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AppDetailDialog } from "./app-detail-dialog"
import { makeAppInstance, makeAppTemplate } from "@/lib/storybook/fixtures/a2ui"

const meta = {
  title: "A2UI/AppDetailDialog",
  component: AppDetailDialog,
  parameters: { layout: "fullscreen" },
  args: {
    app: makeAppInstance(),
    template: makeAppTemplate(),
    open: true,
    onOpenChange: fn(),
    onSave: fn(),
    onGenerateThumbnail: fn(),
    onPreparePublish: fn(() => ({ valid: true, missing: [] })),
  },
} satisfies Meta<typeof AppDetailDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Published: Story = {
  args: {
    app: makeAppInstance({
      isPublished: true,
      publishedAt: Date.now() - 7 * 86_400_000,
      storeId: "store-abc123",
    }),
  },
}

export const MinimalMetadata: Story = {
  args: {
    app: makeAppInstance({
      description: undefined,
      tags: [],
      author: undefined,
      stats: undefined,
    }),
  },
}
