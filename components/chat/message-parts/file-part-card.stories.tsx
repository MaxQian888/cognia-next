import type { Meta, StoryObj } from "@storybook/nextjs"

import { AttachmentTextCard } from "./attachment-text-card"
import { FilePartCard } from "./file-part-preview"

// How sent files look in the transcript: the same file card the composer drew
// for them before the send.
const TS_SOURCE = `export function add(a: number, b: number): number {
  return a + b
}
`
const textDataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(TS_SOURCE)

const meta = {
  title: "Chat/MessageParts/FilePartCard",
  component: FilePartCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof FilePartCard>

export default meta
type Story = StoryObj<typeof meta>

// A previewable file: the card heads the inline preview and collapses it.
export const CodeFile: Story = {
  args: { url: textDataUrl, filename: "add.ts", mediaType: "text/plain" },
}

// No inline preview: the download card alone.
export const BinaryFile: Story = {
  args: {
    url: "https://example.com/archive.zip",
    filename: "quarterly-archive-final.zip",
    mediaType: "application/zip",
  },
}

// A document the user attached, sent as its extracted text, next to a file
// part: one card language for both.
export const SentDocuments: Story = {
  args: { url: textDataUrl, filename: "add.ts", mediaType: "text/plain", defaultExpanded: false },
  render: (args) => (
    <div className="flex max-w-2xl flex-col gap-1">
      <AttachmentTextCard
        filename="quarterly-report.pdf"
        mediaType="application/pdf"
        text={"Revenue grew 18% quarter over quarter.\n".repeat(40)}
      />
      <AttachmentTextCard filename="notes.md" mediaType="text/markdown" text="# Notes\nhello" />
      <FilePartCard {...args} />
    </div>
  ),
}
