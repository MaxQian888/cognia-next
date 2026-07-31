import type { Meta, StoryObj } from "@storybook/nextjs"

import { FilePartPreview } from "./file-part-preview"

// data: URLs let the preview's fetch resolve without a network round-trip.
const TS_SOURCE = `export function add(a: number, b: number): number {
  return a + b
}
`
const textDataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(TS_SOURCE)

const meta = {
  title: "Chat/MessageParts/FilePartPreview",
  component: FilePartPreview,
  parameters: { layout: "padded" },
} satisfies Meta<typeof FilePartPreview>

export default meta
type Story = StoryObj<typeof meta>

// Text/code file → syntax-highlighted CodeBlock with the filename header.
export const TextFile: Story = {
  args: { url: textDataUrl, filename: "add.ts", mediaType: "text/plain" },
}

// PDF → embedded <object> viewer with a download fallback inside.
export const PdfFile: Story = {
  args: {
    url: "https://example.com/report.pdf",
    filename: "quarterly-report.pdf",
    mediaType: "application/pdf",
  },
}

// Unknown/binary type → plain download link fallback.
export const BinaryFallback: Story = {
  args: {
    url: "https://example.com/archive.zip",
    filename: "archive.zip",
    mediaType: "application/zip",
  },
}
