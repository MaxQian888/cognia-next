import type { Meta, StoryObj } from "@storybook/nextjs"

import { MatchHighlight } from "./match-highlight"

// Renders a string with the matched character positions emphasized — used by
// the composer popover to show WHY a fuzzy candidate matched the query.
const meta = {
  title: "Chat/Completion/MatchHighlight",
  component: MatchHighlight,
  parameters: { layout: "centered" },
  args: {
    text: "git/commit",
    positions: [0, 4],
  },
} satisfies Meta<typeof MatchHighlight>

export default meta
type Story = StoryObj<typeof meta>

/** A `gc` query matching `git/commit` → g and c emphasized. */
export const Default: Story = {}

/** A contiguous run of matches coalesces into a single <mark>. */
export const ContiguousRun: Story = {
  args: {
    text: "workflow-designer",
    positions: [0, 1, 2, 3],
  },
}

/** No positions → the text renders verbatim with no extra markup. */
export const NoMatches: Story = {
  args: {
    text: "no-highlight-here",
    positions: [],
  },
}

/** Out-of-range indices are ignored; only the valid ones emphasize. */
export const OutOfRangeIgnored: Story = {
  args: {
    text: "search",
    positions: [0, 99, 5],
  },
}

/** A custom mark class can theme the emphasized runs. */
export const CustomMarkClass: Story = {
  args: {
    text: "primary-accent",
    positions: [0, 1, 2, 3, 4, 5, 6],
    markClassName: "text-primary underline",
  },
}
