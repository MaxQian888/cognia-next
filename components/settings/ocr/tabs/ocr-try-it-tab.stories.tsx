import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrTryItTab } from "./ocr-try-it-tab"

// Try-it tab: drop an image/PDF, confirm the cost dialog, then run the selected
// provider through `useOcr()`. With `depsFactory` returning null the OCR
// runtime is "not ready", so the Run button surfaces an explanatory alert
// instead of executing — the safe browser-shell rendering.
const meta = {
  title: "Settings/Ocr/Tabs/OcrTryItTab",
  component: OcrTryItTab,
  parameters: { layout: "padded" },
  args: { providerId: "tesseract", depsFactory: () => null, onCopy: fn() },
} satisfies Meta<typeof OcrTryItTab>

export default meta
type Story = StoryObj<typeof meta>

// Runtime not ready (no deps factory result) → drop zone + "not ready" path.
export const RuntimeNotReady: Story = {}

// A cloud provider selected (cost estimate reflects the provider id).
export const CloudProvider: Story = {
  args: { providerId: "mistral-ocr" },
}
