import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrResultBubble } from "./ocr-result-bubble"
import type { OcrResult } from "@/types/ocr"

// Side sheet that displays per-page OCR Markdown. Controlled via open /
// onOpenChange. Shows a per-page copy button and a combined-markdown copy.
const result = (over: Partial<OcrResult> = {}): OcrResult => ({
  providerId: "tesseract",
  languages: ["en"],
  durationMs: 820,
  cached: false,
  combinedText: "Invoice #1042\nBilled to: Acme Corp",
  combinedMarkdown: "# Invoice #1042\n\nBilled to: **Acme Corp**\n\nTotal due: $1,240.00",
  pages: [
    {
      pageNumber: 1,
      markdown: "# Invoice #1042\n\nBilled to: **Acme Corp**",
      text: "Invoice #1042\nBilled to: Acme Corp",
    },
    {
      pageNumber: 2,
      markdown: "## Line items\n\n- Widgets × 10\n- Total due: $1,240.00",
      text: "Line items\nWidgets x 10\nTotal due: $1,240.00",
    },
  ],
  ...over,
})

const meta = {
  title: "Chat/Composer/OcrResultBubble",
  component: OcrResultBubble,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    result: result(),
    onCopy: fn(),
    onCopyPage: fn(),
  },
} satisfies Meta<typeof OcrResultBubble>

export default meta
type Story = StoryObj<typeof meta>

/** Two-page result with per-page + combined copy actions. */
export const MultiPage: Story = {}

/** A single page. */
export const SinglePage: Story = {
  args: {
    result: result({
      pages: [
        {
          pageNumber: 1,
          markdown: "Just one page of recognized text.",
          text: "Just one page of recognized text.",
        },
      ],
    }),
  },
}

/** No pages → the empty-state copy. */
export const Empty: Story = {
  args: { result: result({ pages: [], combinedMarkdown: "" }) },
}
