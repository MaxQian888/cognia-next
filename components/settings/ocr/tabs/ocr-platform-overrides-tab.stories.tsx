import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrPlatformOverridesTab } from "./ocr-platform-overrides-tab"
import { makeOcrSettings } from "@/lib/storybook/fixtures/settings-ocr-tabs"

// Pure, props-only: per-OS reorderable local-engine preference. With no
// `platformOverrides` set, each OS bucket falls back to DEFAULT_LOCAL_PREFERENCE
// and shows "using default"; a populated override shows "using override" with an
// enabled reset button.
const meta = {
  title: "Settings/Ocr/Tabs/OcrPlatformOverridesTab",
  component: OcrPlatformOverridesTab,
  args: {
    settings: makeOcrSettings(),
    onChange: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrPlatformOverridesTab>

export default meta
type Story = StoryObj<typeof meta>

// All buckets inherit the defaults (reset buttons disabled).
export const Defaults: Story = {}

// Windows bucket has a custom order → "using override" + enabled reset.
export const WithOverride: Story = {
  args: {
    settings: makeOcrSettings({
      platformOverrides: {
        windows: ["ocrs", "tesseract-wasm"],
        macos: ["apple-vision", "ocrs"],
      },
    }),
  },
}
