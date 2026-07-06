import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrSetupWizard } from "./ocr-setup-wizard"
import { makeOcrSettings } from "@/lib/storybook/fixtures/settings-ocr"

// First-visit setup wizard, rendered inside a Dialog. Pure: `open`, `settings`,
// and three callbacks. The internal step state (use-case → preset → apply) is
// driven by the in-dialog Next/Back buttons, so the Open story starts at step 1
// and the dialog chrome exercises the rest.
const meta = {
  title: "Settings/Ocr/OcrSetupWizard",
  component: OcrSetupWizard,
  args: {
    open: true,
    settings: makeOcrSettings(),
    onOpenChange: fn(),
    onApply: fn(),
    onDismiss: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof OcrSetupWizard>

export default meta
type Story = StoryObj<typeof meta>

/** Open on the first step — pick a use-case. */
export const Open: Story = {}

/** Closed — nothing renders (the Dialog is unmounted). */
export const Closed: Story = {
  args: { open: false },
}

/** Open against settings the user has already touched once. */
export const PreviouslyDismissed: Story = {
  args: { settings: makeOcrSettings({ ocrWizardDismissed: true }) },
}
