import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { FollowUpSuggestions } from "./follow-up-suggestions"
// Resolves to the same module the component imports (aliased in .storybook/main.ts),
// so setting the value here drives what the mocked hook returns.
import { __setFollowUps } from "@/hooks/chat/use-follow-up-suggestions.mock"

const setSuggestions = (suggestions: string[]) => async () => {
  __setFollowUps({ suggestions, loading: false, dismiss: fn() })
}

const meta = {
  title: "Chat/FollowUpSuggestions",
  component: FollowUpSuggestions,
  args: {
    session: null,
    onUseSample: fn(),
  },
  beforeEach: setSuggestions([
    "Tell me more about that.",
    "Why is that the case?",
    "Show me an example.",
  ]),
} satisfies Meta<typeof FollowUpSuggestions>

export default meta
type Story = StoryObj<typeof meta>

export const ThreeSuggestions: Story = {}

export const SingleSuggestion: Story = {
  beforeEach: setSuggestions(["Continue."]),
}
