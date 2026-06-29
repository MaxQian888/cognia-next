import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactElement } from "react"

import { ScreenshotButton } from "./screenshot-button"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"

// Screen-capture button that pipes the result into the composer's attachments.
// Needs the PromptInput attachments sink, so wrap in PromptInputProvider.
// (Clicking opens the screen-share picker, a no-op in Storybook.)
function withProvider(Story: () => ReactElement) {
  return (
    <PromptInputProvider>
      <Story />
    </PromptInputProvider>
  )
}

const meta = {
  title: "Chat/Composer/ScreenshotButton",
  component: ScreenshotButton,
  parameters: { layout: "centered" },
  decorators: [withProvider],
} satisfies Meta<typeof ScreenshotButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: { disabled: true },
}
