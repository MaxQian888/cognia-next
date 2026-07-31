import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrAdvancedTab } from "./ocr-advanced-tab"

// Pure, props-only component. Field visibility is driven entirely by
// `providerId` against static provider-class sets, so each story picks a
// representative provider to surface a different field combination.
const meta = {
  title: "Settings/Ocr/Tabs/OcrAdvancedTab",
  component: OcrAdvancedTab,
  args: {
    providerId: "mistral-ocr",
    config: {},
    onConfigChange: fn(),
    onClearProviderCache: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrAdvancedTab>

export default meta
type Story = StoryObj<typeof meta>

// Cloud document provider: format + languages + model variant (no region/prompt).
export const CloudProvider: Story = {}

// AWS Textract gains the region override field.
export const AwsTextract: Story = {
  args: { providerId: "aws-textract" },
}

// LLM-vision provider: model variant + prompt template overrides.
export const VisionProvider: Story = {
  args: { providerId: "anthropic-vision" },
}

// Local engine: only format + languages overrides are shown.
export const LocalEngine: Story = {
  args: { providerId: "tesseract-wasm" },
}

// Pre-filled overrides so the form reflects an already-customised provider.
export const WithExistingOverrides: Story = {
  args: {
    providerId: "anthropic-vision",
    config: {
      format: "text",
      languages: "en,zh",
      modelVariant: "claude-3-5-sonnet",
      promptTemplate: "Transcribe all text, preserving tables as Markdown.",
    },
  },
}
