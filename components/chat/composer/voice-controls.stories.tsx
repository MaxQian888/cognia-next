import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { VoiceControls } from "./voice-controls"

// Composer voice controls — a hold-to-talk SpeechInput button plus a settings
// popover for picking the microphone and recognition language. Choices persist
// to AppSettings. (Web Speech API is unavailable in Storybook, so the talk
// button may render disabled; the settings popover is the interesting surface.)
const meta = {
  title: "Chat/Composer/VoiceControls",
  component: VoiceControls,
  parameters: { layout: "centered" },
  args: { onTranscription: fn() },
} satisfies Meta<typeof VoiceControls>

export default meta
type Story = StoryObj<typeof meta>

/** Talk button + settings gear. Open the gear for mic + language pickers. */
export const Default: Story = {}

/** Disabled (e.g. while a turn streams). */
export const Disabled: Story = {
  args: { disabled: true },
}
