import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DocumentFormatToolbar } from "./document-format-toolbar"

// Markdown formatting toolbar (bold / italic / headings / lists / link / rule).
// Each button fires `onAction` with the corresponding FormatAction.
const meta = {
  title: "Document/DocumentFormatToolbar",
  component: DocumentFormatToolbar,
  args: { onAction: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof DocumentFormatToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
