import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetInteractionControls } from "./pet-interaction-controls"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

// Interaction + speech controls: muted bubbles, custom catchphrases, opt-in LLM
// speak (reveals a model override), proactive speech, and conversation memory.
// Pure props over the shared `{ pet, patch }` interface.
const meta = {
  title: "Pet/Settings/InteractionControls",
  component: PetInteractionControls,
  parameters: { layout: "padded" },
  args: { pet: { ...DEFAULT_PET_SETTINGS }, patch: fn() },
  decorators: [
    (Story) => (
      <div className="max-w-md space-y-4 rounded-xl border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetInteractionControls>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithCatchphrases: Story = {
  args: {
    pet: { ...DEFAULT_PET_SETTINGS, customBubbles: ["ship it", "looks good to me", "🐛?"] },
  },
}

export const LlmSpeakEnabled: Story = {
  args: {
    pet: {
      ...DEFAULT_PET_SETTINGS,
      llmSpeak: { enabled: true },
      proactive: {
        enabled: true,
        tier: "chatty",
        eventComments: true,
        idleChatter: true,
        timeGreetings: false,
      },
    },
  },
}
