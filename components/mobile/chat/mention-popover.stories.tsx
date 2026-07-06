import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MentionPopover } from "./mention-popover"
import { makeCharacterRoster } from "@/lib/storybook/fixtures/mobile"

// Mobile @-mention picker (shadcn Sheet anchored above the composer). Pure:
// `members` is the roster, `query` filters by name, and the empty / no-match
// branches render their own copy. `open` keeps the sheet mounted for the story.
const roster = makeCharacterRoster()

const meta = {
  title: "Mobile/Chat/MentionPopover",
  component: MentionPopover,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    query: "",
    members: roster,
    composerHeight: 96,
    onPick: fn(),
    onDismiss: fn(),
  },
} satisfies Meta<typeof MentionPopover>

export default meta
type Story = StoryObj<typeof meta>

/** Full roster, no filter. */
export const AllMembers: Story = {}

/** Filtered by a query that matches a subset. */
export const Filtered: Story = {
  args: { query: "re" },
}

/** A query that matches nobody. */
export const NoMatches: Story = {
  args: { query: "zzz" },
}

/** No members configured at all. */
export const NoMembers: Story = {
  args: { members: [] },
}
