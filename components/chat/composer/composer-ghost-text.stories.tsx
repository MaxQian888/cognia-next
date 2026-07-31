import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ReactElement } from "react"

import { ComposerGhostText } from "./composer-ghost-text"

// The ghost layer is absolutely positioned (inset-0), so it needs a relative,
// sized box to anchor to — mirroring the composer textarea it overlays.
function inComposerBox(Story: () => ReactElement) {
  return (
    <div className="relative min-h-24 w-96 rounded-md border bg-background p-2">
      <Story />
    </div>
  )
}

const meta = {
  title: "Chat/Composer/ComposerGhostText",
  component: ComposerGhostText,
  parameters: { layout: "padded" },
  decorators: [inComposerBox],
  args: {
    value: "Refactor the redaction gate so it ",
    ghost: "runs before every outbound LLM call.",
  },
} satisfies Meta<typeof ComposerGhostText>

export default meta
type Story = StoryObj<typeof meta>

// Dim continuation trailing the typed text.
export const Default: Story = {}

// With the "Tab" accept hint badge.
export const WithAcceptHint: Story = {
  args: { acceptHint: "Tab" },
}

// Empty ghost → renders nothing (null).
export const NoSuggestion: Story = {
  args: { ghost: "" },
}
