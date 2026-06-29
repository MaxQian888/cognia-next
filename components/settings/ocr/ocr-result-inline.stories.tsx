import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrResultInline } from "./ocr-result-inline"
import { makeOcrPage, makeOcrResult } from "@/lib/storybook/fixtures/settings-ocr"

// Pure renderer for an `OcrResult`. Renders the empty hint when result is null
// or has no pages, otherwise a metadata row plus one article per page. The
// copy buttons only appear when their handlers are supplied.
const meta = {
  title: "Settings/Ocr/OcrResultInline",
  component: OcrResultInline,
  args: {
    result: makeOcrResult(),
    onCopy: fn(),
    onCopyPage: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OcrResultInline>

export default meta
type Story = StoryObj<typeof meta>

export const SinglePage: Story = {}

export const MultiPage: Story = {
  args: {
    result: makeOcrResult({
      pages: [
        makeOcrPage({ pageNumber: 1 }),
        makeOcrPage({ pageNumber: 2, markdown: "## Page two\n\nMore extracted text." }),
        makeOcrPage({
          pageNumber: 3,
          fromTextLayer: true,
          markdown: "Page three from text layer.",
        }),
      ],
    }),
  },
}

export const CachedWithCost: Story = {
  args: {
    result: makeOcrResult({
      cached: true,
      costEstimate: { unit: "page", amount: 0.0125, currency: "USD" },
    }),
  },
}

/** No copy handlers → the per-page and combined copy buttons are hidden. */
export const ReadOnly: Story = {
  args: { onCopy: undefined, onCopyPage: undefined, showCombinedCopy: false },
}

export const Empty: Story = {
  args: { result: null },
}

export const NoPages: Story = {
  args: { result: makeOcrResult({ pages: [], combinedMarkdown: "" }) },
}
