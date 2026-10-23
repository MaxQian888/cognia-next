import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { FollowUpSuggestions } from "./follow-up-suggestions"
import { useUIStore } from "@/stores/ui/ui-store"

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
export const SetupHint: Story = {
  parameters: { layout: "padded" },
  args: { suggestions: [], status: "unavailable", onConfigure: fn(), onRetry: fn() },
  beforeEach: () => {
    useUIStore.setState({ predictionSetupHintHidden: false })
  },
}
export const GenerationError: Story = {
  parameters: { layout: "padded" },
  args: { suggestions: [], status: "error", onRetry: fn() },
}
