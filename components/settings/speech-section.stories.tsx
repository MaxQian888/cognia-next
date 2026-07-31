import type { Meta, StoryObj } from "@storybook/nextjs"

import { SpeechSection } from "./speech-section"

// `SpeechSection` simply stacks the STT (voice input) and TTS (read-aloud) cards.
// Both cards own their own chrome and read the settings store; with the store at
// its defaults they render their idle configuration.
const meta = {
  title: "Settings/SpeechSection",
  component: SpeechSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpeechSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
