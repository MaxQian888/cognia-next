import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SuggestionItem } from "./suggestion-item"
import { makeCanvasSuggestion } from "@/lib/storybook/fixtures/canvas"

// SuggestionItem is a pure, props-only card: it renders one AI suggestion with
// a type badge, an explanation, an optional collapsible diff preview, and
// apply / dismiss actions. No store subscription.
const meta = {
  title: "Canvas/SuggestionItem",
  component: SuggestionItem,
  parameters: { layout: "padded" },
  args: {
    onApply: fn(),
    onReject: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SuggestionItem>

export default meta
type Story = StoryObj<typeof meta>

// Pending "improve" suggestion with a before/after diff — the most common state.
export const Improve: Story = {
  args: {
    suggestion: makeCanvasSuggestion(),
  },
}

// A "fix" suggestion (red bug icon) spanning multiple lines.
export const Fix: Story = {
  args: {
    suggestion: makeCanvasSuggestion({
      type: "fix",
      range: { startLine: 2, endLine: 4 },
      originalText: "if (name == null) return",
      suggestedText: "if (name === null || name === undefined) return",
      explanation: "Use strict equality and guard against undefined.",
    }),
  },
}

// A comment-only suggestion with no diff preview (no original/suggested text).
export const CommentOnly: Story = {
  args: {
    suggestion: makeCanvasSuggestion({
      type: "comment",
      originalText: "",
      suggestedText: "",
      explanation: "Consider documenting why empty names are skipped.",
    }),
  },
}

// Accepted suggestions render dimmed with an "applied" badge and no actions.
export const Accepted: Story = {
  args: {
    suggestion: makeCanvasSuggestion({ status: "accepted" }),
  },
}

// Rejected suggestions render struck-through with a "dismissed" badge.
export const Rejected: Story = {
  args: {
    suggestion: makeCanvasSuggestion({ status: "rejected" }),
  },
}
