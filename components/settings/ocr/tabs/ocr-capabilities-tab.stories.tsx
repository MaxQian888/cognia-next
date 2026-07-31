import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrCapabilitiesTab } from "./ocr-capabilities-tab"

// Pure component: reads the static `OCR_PROVIDER_CAPABILITIES` map by
// `providerId` and renders the capability matrix (or an empty state for an
// unknown provider).
const meta = {
  title: "Settings/Ocr/Tabs/OcrCapabilitiesTab",
  component: OcrCapabilitiesTab,
  args: { providerId: "mathpix" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrCapabilitiesTab>

export default meta
type Story = StoryObj<typeof meta>

// Cloud provider with broad capabilities (handwriting, math, tables, …).
export const Mathpix: Story = {}

// Local engine — note the "unlimited" pages cell and offline support.
export const LocalEngine: Story = {
  args: { providerId: "tesseract-wasm" },
}

// Compare CTA appears only when `onCompareClick` is supplied.
export const WithCompareCta: Story = {
  args: { providerId: "mistral-ocr", onCompareClick: fn() },
}

// Unknown provider id → the empty state.
export const UnknownProvider: Story = {
  args: { providerId: "does-not-exist" },
}
