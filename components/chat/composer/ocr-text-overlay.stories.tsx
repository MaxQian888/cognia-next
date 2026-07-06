import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrTextOverlay } from "./ocr-text-overlay"
import type { OcrDocumentPage } from "@/types/ocr"

// Live-Text-style selectable overlay: the source image with transparent,
// user-selectable text spans positioned over each block's bbox.
const PAGE_W = 600
const PAGE_H = 400

const block = (
  id: string,
  text: string,
  bbox: { x: number; y: number; width: number; height: number }
) => ({
  id,
  type: "paragraph" as const,
  text,
  bbox,
  readingOrderIndex: Number(id.split(".")[1] ?? 0),
  provenance: { providerId: "tesseract", pageNumber: 1 },
})

const page: OcrDocumentPage = {
  pageNumber: 1,
  width: PAGE_W,
  height: PAGE_H,
  blocks: [
    block("0.0", "Invoice #1042", { x: 40, y: 30, width: 240, height: 36 }),
    block("0.1", "Billed to: Acme Corp", { x: 40, y: 90, width: 300, height: 28 }),
    block("0.2", "Total due: $1,240.00", { x: 40, y: 320, width: 280, height: 30 }),
  ],
}

// A neutral placeholder "scan" so the overlay spans have something to sit over.
const imageSrc =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${PAGE_W}' height='${PAGE_H}'><rect width='100%' height='100%' fill='%23f4f4f5'/></svg>`
  )

const meta = {
  title: "Chat/Composer/OcrTextOverlay",
  component: OcrTextOverlay,
  parameters: { layout: "padded" },
  args: { imageSrc, page, onBlockClick: fn() },
} satisfies Meta<typeof OcrTextOverlay>

export default meta
type Story = StoryObj<typeof meta>

/** Three positioned, selectable text regions over the page image. */
export const Default: Story = {}

/** A block highlighted as the resolved citation target. */
export const HighlightedBlock: Story = {
  args: { highlightedId: "0.1" },
}
