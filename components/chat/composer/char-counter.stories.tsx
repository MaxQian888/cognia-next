import type { Meta, StoryObj } from "@storybook/nextjs"

import { CharCounter } from "./char-counter"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"

// CharCounter reads `usePromptInputController().textInput.value.length`, so it
// must live inside a PromptInputProvider. The provider's `initialInput` seeds
// the textarea value — its length drives both visibility (hidden at 0) and the
// muted → amber (≥8k) → destructive (≥10k) colour ramp.
function provider(initialInput: string) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <PromptInputProvider initialInput={initialInput}>
        {/* relative box so the counter's absolute overlay has somewhere to anchor */}
        <div className="relative h-16 w-72 rounded-md border bg-muted/20">
          <Story />
        </div>
      </PromptInputProvider>
    )
  }
}

const meta = {
  title: "Chat/Composer/CharCounter",
  component: CharCounter,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CharCounter>

export default meta
type Story = StoryObj<typeof meta>

// Well under 8k — muted, low-key count.
export const Normal: Story = {
  decorators: [provider("a".repeat(1_280))],
}

// 8k–10k window — amber warning tint.
export const Amber: Story = {
  decorators: [provider("a".repeat(8_500))],
}

// Past 10k — destructive red.
export const OverLimit: Story = {
  decorators: [provider("a".repeat(11_200))],
}
