import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrCompareView } from "./ocr-compare-view"
import { SAMPLE_COMPARE_PROVIDERS } from "@/lib/storybook/fixtures/settings-ocr"

// Multi-provider compare surface. Props-driven: provider options, an initial
// selection, a back handler, and a `depsFactory` that yields OCR ExtractDeps.
// Stories return `null` from the factory so the (interactive) run path surfaces
// the "runtime not ready" alert instead of calling the real `extract()` —
// extraction deps aren't wired in Storybook.
const meta = {
  title: "Settings/Ocr/OcrCompareView",
  component: OcrCompareView,
  args: {
    providers: SAMPLE_COMPARE_PROVIDERS,
    onBack: fn(),
    depsFactory: () => null,
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OcrCompareView>

export default meta
type Story = StoryObj<typeof meta>

/** No providers selected yet → empty-state hint in the result area. */
export const EmptySelection: Story = {}

/** Two providers pre-selected → two idle result columns. */
export const TwoSelected: Story = {
  args: { initialSelectedIds: ["mistral-ocr", "google-vision"] },
}

/** Selection capped at three — the Add button disables at the max. */
export const MaxSelected: Story = {
  args: { initialSelectedIds: ["mistral-ocr", "google-vision", "paddle-ocr"] },
}
