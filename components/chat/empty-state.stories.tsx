import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { EmptyChatState } from "./empty-state"

const meta = {
  title: "Chat/EmptyChatState",
  component: EmptyChatState,
  args: {
    onCreate: fn(),
    onUseSample: fn(),
    aiSamples: [
      "Summarize the key risks in this codebase.",
      "Write a unit test for the selected function.",
      "Explain this stack trace and suggest a fix.",
    ],
  },
} satisfies Meta<typeof EmptyChatState>

export default meta
type Story = StoryObj<typeof meta>

export const Fullscreen: Story = {
  args: { variant: "fullscreen" },
  parameters: { layout: "fullscreen" },
}

export const Inline: Story = {
  args: { variant: "inline" },
}

export const WithUserName: Story = {
  args: { variant: "fullscreen", userName: "Max" },
  parameters: { layout: "fullscreen" },
}
