import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SessionRow } from "./session-row"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

// The channel-list session row: icon + title (double-click to rename inline),
// optional metadata, pin/branch indicators + unread badge, and a hover actions menu.
const makeSession = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "ses_1",
    title: "Refactor the auth flow",
    kind: "direct",
    ...over,
  }) as ChatSession

const folders: SessionFolder[] = [
  { id: "f1", name: "Work" } as SessionFolder,
  { id: "f2", name: "Personal" } as SessionFolder,
]

const meta = {
  title: "Desktop/SessionRow",
  component: SessionRow,
  parameters: { layout: "padded" },
  args: {
    session: makeSession(),
    active: false,
    onSelect: fn(),
    onDelete: fn(),
    onRename: fn(),
    onTogglePinned: fn(),
    onArchive: fn(),
    onAssignToFolder: fn(),
    folders,
  },
  decorators: [
    (Story) => (
      <ul className="w-72 rounded-md border p-1">
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof SessionRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Active: Story = { args: { active: true } }

export const Selected: Story = { args: { selected: true } }

export const Pinned: Story = {
  args: { session: makeSession({ pinned: true }), accentColor: "#6d5ae0" },
}

export const Unread: Story = { args: { unread: 7 } }

export const RichMetadata: Story = {
  args: {
    metadata: [
      { kind: "agent", value: "Research Agent" },
      { kind: "model", value: "Claude Sonnet 4.5" },
      { kind: "provider", value: "Anthropic" },
    ],
  },
}

export const TeamSession: Story = {
  args: { session: makeSession({ kind: "team", title: "Release squad", teamId: "t1" }) },
}

export const LongTitle: Story = {
  args: {
    session: makeSession({
      title: "Plan the complete cross-platform release workflow and verification strategy",
      pinned: true,
      lastMessagePreview: "Review the remaining launch checks",
    }),
    unread: 12,
    showPreview: true,
    metadata: [
      { kind: "agent", value: "Release Coordinator" },
      { kind: "model", value: "GPT-5.4" },
    ],
  },
}

export const Branched: Story = {
  args: {
    session: makeSession({ title: "Branch: alt approach", parentSessionId: "ses_parent" }),
    onJumpToParent: fn(),
  },
}

/**
 * Timestamp column: the trailing last-activity time that makes a
 * recency-ordered list legible. Shapes narrow as the row ages — a clock time
 * today, a weekday inside the week, a date beyond that.
 */
export const WithTimestamp: Story = {
  args: {
    showTimestamp: true,
    session: makeSession({
      title: "Ship the release notes",
      lastMessageAt: Date.now() - 3_600_000,
    }),
  },
}

export const TimestampAndUnread: Story = {
  args: {
    showTimestamp: true,
    unread: 3,
    session: makeSession({
      title: "Standup follow-ups",
      lastMessageAt: Date.now() - 3 * 86_400_000,
    }),
  },
}

/** Active vs hover used to be the same `bg-accent`; the bar disambiguates. */
export const ActiveWithTimestamp: Story = {
  args: {
    active: true,
    showTimestamp: true,
    session: makeSession({ title: "The open conversation", lastMessageAt: Date.now() }),
  },
}

/** How a search result reads: the matched run is emphasized in the title. */
export const SearchHit: Story = {
  args: {
    searchQuery: "release",
    showTimestamp: true,
    session: makeSession({
      title: "Release checklist review",
      lastMessageAt: Date.now() - 86_400_000,
    }),
  },
}

/**
 * A hit that only matched inside messages. Without the marker, a result whose
 * title has nothing to do with the query reads as a broken search.
 */
export const ContentOnlyHit: Story = {
  args: {
    searchQuery: "sqlite",
    contentMatch: true,
    showTimestamp: true,
    session: makeSession({
      title: "Tuesday debugging",
      lastMessageAt: Date.now() - 9 * 86_400_000,
    }),
  },
}
