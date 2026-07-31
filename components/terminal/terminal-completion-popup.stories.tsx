import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TerminalCompletionPopup } from "./terminal-completion-popup"
import { makeSuggestion } from "@/lib/storybook/fixtures/terminal"

// Multi-candidate completion popup. Presentational; the parent anchors it to the
// cursor. Each row shows a source icon, the candidate text, and a warning badge
// when the command-safety classifier returns an `ask` verdict.
const candidates = [
  makeSuggestion({ text: "git status", source: "history", description: "git" }),
  makeSuggestion({ text: "git stash pop", source: "ai", providerId: "builtin:ai" }),
  makeSuggestion({ text: "git switch -", source: "spec", providerId: "git:switch" }),
  makeSuggestion({
    text: "rm -rf node_modules",
    source: "history",
    description: "danger",
  }),
]

const meta = {
  title: "Terminal/CompletionPopup",
  component: TerminalCompletionPopup,
  parameters: { layout: "padded" },
  args: {
    candidates,
    selectedIndex: 0,
    left: 16,
    top: 240,
    fontFamily: "monospace",
    fontSize: 14,
    onPick: fn(),
  },
  decorators: [
    (Story) => (
      <div className="relative h-64 w-[480px] rounded bg-[#1f2430]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalCompletionPopup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const SecondSelected: Story = { args: { selectedIndex: 1 } }

export const SingleCandidate: Story = {
  args: { candidates: [candidates[0]] },
}

export const Empty: Story = {
  args: { candidates: [] },
}
