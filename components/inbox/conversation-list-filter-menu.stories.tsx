import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"

import {
  ConversationListFilterMenu,
  type ConversationFilterChip,
} from "./conversation-list-filter-menu"

// Replaces the four permanently-visible Toggle chips in the conversation-list
// header. The trigger label collapses below 15rem of `@container/conversation-list`
// width, so the stories set that container explicitly.
const meta = {
  title: "Inbox/ConversationListFilterMenu",
  component: ConversationListFilterMenu,
  parameters: { layout: "centered" },
  // Every story renders its own stateful wrapper; these satisfy the required
  // props so the stories stay `render`-only.
  args: {
    active: new Set<ConversationFilterChip>(),
    onToggle: () => {},
    onClear: () => {},
  },
} satisfies Meta<typeof ConversationListFilterMenu>

export default meta
type Story = StoryObj<typeof meta>

/** Live control so the checkbox items and the count badge can be exercised. */
function Interactive({ initial = [] }: { initial?: ConversationFilterChip[] }) {
  const [active, setActive] = useState<Set<ConversationFilterChip>>(() => new Set(initial))
  return (
    <ConversationListFilterMenu
      active={active}
      onToggle={(chip) =>
        setActive((prev) => {
          const next = new Set(prev)
          if (next.has(chip)) next.delete(chip)
          else next.add(chip)
          return next
        })
      }
      onClear={() => setActive(new Set())}
    />
  )
}

export const Idle: Story = {
  render: () => (
    <div className="@container/conversation-list w-72">
      <Interactive />
    </div>
  ),
}

export const WithActiveFilters: Story = {
  render: () => (
    <div className="@container/conversation-list w-72">
      <Interactive initial={["unread", "pinned"]} />
    </div>
  ),
}

/** At the list pane's minimum width the trigger drops its text label. */
export const NarrowRail: Story = {
  render: () => (
    <div className="@container/conversation-list w-40">
      <Interactive initial={["snoozed"]} />
    </div>
  ),
}
