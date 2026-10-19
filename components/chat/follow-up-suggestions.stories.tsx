import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { FollowUpSuggestions } from "./follow-up-suggestions"

const meta = {
  title: "Chat/FollowUpSuggestions",
  component: FollowUpSuggestions,
  args: {
    suggestions: ["Tell me more about that.", "Why is that the case?", "Show me an example."],
    onAccept: fn(),
    onDismiss: fn(),
  },
} satisfies Meta<typeof FollowUpSuggestions>
export default meta
type Story = StoryObj<typeof meta>
export const ThreeSuggestions: Story = {}
export const SingleSuggestion: Story = { args: { suggestions: ["Continue."] } }
export const DirectSend: Story = { args: { directSend: true } }
