import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SessionRow } from "./session-row"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

// The channel-list session row: icon + title (double-click to rename inline),
// optional pin/branch indicators + unread badge, and a hover actions menu.
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

export const TeamSession: Story = {
  args: { session: makeSession({ kind: "team", title: "Release squad", teamId: "t1" }) },
}

export const Branched: Story = {
  args: {
    session: makeSession({ title: "Branch: alt approach", parentSessionId: "ses_parent" }),
    onJumpToParent: fn(),
  },
}
