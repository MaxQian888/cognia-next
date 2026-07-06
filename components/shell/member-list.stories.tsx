import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemberList } from "./member-list"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useUIStore } from "@/stores/ui"

// Right rail for team sessions. Visibility + collapse come from the UI store;
// the member roster + scratchpad read Dexie (empty here → the empty roster and
// an empty scratchpad). Returns null without a team session, so both ids are
// supplied.
const meta = {
  title: "Shell/MemberList",
  component: MemberList,
  parameters: { layout: "fullscreen" },
  args: { teamSessionId: "team-sess-1", teamId: "team-1", onMention: fn() },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] justify-end">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemberList>

export default meta
type Story = StoryObj<typeof meta>

export const Expanded: Story = {
  beforeEach: () => {
    resetStore(useUIStore)
    seedStore(useUIStore, { showMemberList: true })
  },
}

// Collapsed rail → just the re-open button.
export const Collapsed: Story = {
  beforeEach: () => {
    resetStore(useUIStore)
    seedStore(useUIStore, { showMemberList: false })
  },
}
