import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DraftRestoredAttachments } from "./draft-restored-attachments"

const meta = {
  title: "Chat/Composer/DraftRestoredAttachments",
  component: DraftRestoredAttachments,
  parameters: { layout: "padded" },
  args: { onDismiss: fn() },
} satisfies Meta<typeof DraftRestoredAttachments>

export default meta
type Story = StoryObj<typeof meta>

// Reminder chips after a draft restore — files the user needs to re-attach.
export const MultipleFiles: Story = {
  args: {
    items: [
      { name: "screenshot.png", size: 248_512, mediaType: "image/png" },
      { name: "report.pdf", size: 1_048_576, mediaType: "application/pdf" },
      { name: "notes.txt", size: 0, mediaType: "text/plain" },
    ],
  },
}

export const SingleFile: Story = {
  args: {
    items: [{ name: "diagram.svg", size: 4_096, mediaType: "image/svg+xml" }],
  },
}

// Empty list → renders nothing.
export const Empty: Story = {
  args: { items: [] },
}
