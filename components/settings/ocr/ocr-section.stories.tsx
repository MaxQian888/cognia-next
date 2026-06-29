import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrSection } from "./ocr-section"
import { makeOcrSettings } from "@/lib/storybook/fixtures/settings-ocr"

// Full OCR settings shell: provider sidebar + per-provider config/models/cache/
// try-it tabs + the auto-router panel. All props are optional; passing
// `modelBridge={null}` suppresses the local-model UI (the browser shell where
// the Rust commands aren't reachable). No native deps are wired here.
const meta = {
  title: "Settings/Ocr/OcrSection",
  component: OcrSection,
  parameters: { layout: "padded" },
  args: { settings: makeOcrSettings(), modelBridge: null, onChange: fn() },
} satisfies Meta<typeof OcrSection>

export default meta
type Story = StoryObj<typeof meta>

// Default settings, wizard suppressed by passing settings.
export const Default: Story = {}

// Wizard dismissed flag set.
export const WizardDismissed: Story = {
  args: { settings: makeOcrSettings({ ocrWizardDismissed: true }) },
}
