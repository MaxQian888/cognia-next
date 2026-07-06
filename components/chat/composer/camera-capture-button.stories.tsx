import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactElement } from "react"

import { CameraCaptureButton } from "./camera-capture-button"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"

// CameraCaptureButton calls usePromptInputAttachments(), which resolves against
// either a PromptInput or a PromptInputProvider. Wrap in the provider so the
// attachments sink exists. (Clicking opens the native/web camera picker, which
// is a no-op in Storybook.)
function withProvider(Story: () => ReactElement) {
  return (
    <PromptInputProvider>
      <Story />
    </PromptInputProvider>
  )
}

const meta = {
  title: "Chat/Composer/CameraCaptureButton",
  component: CameraCaptureButton,
  parameters: { layout: "centered" },
  decorators: [withProvider],
} satisfies Meta<typeof CameraCaptureButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Disabled: Story = {
  args: { disabled: true },
}
