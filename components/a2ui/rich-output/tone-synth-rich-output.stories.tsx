import type { Meta, StoryObj } from "@storybook/nextjs"

import { ToneSynthRichOutput } from "./tone-synth-rich-output"

// Tone.js synth trigger. Audio only starts on click (browser autoplay policy),
// so the story renders the prompt + Play button.
const meta = {
  title: "A2UI/RichOutput/ToneSynth",
  component: ToneSynthRichOutput,
  parameters: { layout: "centered" },
  args: { prompt: "Play a C4 note" },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToneSynthRichOutput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoPrompt: Story = { args: { prompt: undefined } }
