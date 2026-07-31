import type { Meta, StoryObj } from "@storybook/nextjs"
import { useRef } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"

import { ConversationTimeline } from "./conversation-timeline"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import type { AppSettings } from "@cognia/agent-config-types"

// Right-edge conversation minimap. Collapsed it's a thin rail with proportional
// turn markers; the grip opens the expanded sidebar. Renders only when there are
// user turns to anchor.
//
// Its visibility is a CONTAINER query (`@4xl/message-list`), not a viewport
// breakpoint — so the harness must declare `@container/message-list` and be at
// least 56rem wide, or the rail is display:none and the story shows nothing.
//
// Both states are IN FLOW — the harness below is a flex row, not a positioned
// overlay. The rail used to be `absolute right-0` on top of the scroll
// container, which meant it swallowed every scrollbar drag on platforms with
// classic (non-overlay) scrollbars; it now takes its own 16px lane instead.
const userTurn = (id: string, text: string, time: number): UIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text, state: "done" }],
    metadata: { createdAt: time },
  }) as unknown as UIMessage
const reply = (id: string, text: string, time?: number): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }],
    ...(time == null ? {} : { metadata: { createdAt: time } }),
  }) as unknown as UIMessage

const NULL_VIRTUALIZER = null as unknown as Virtualizer<HTMLDivElement, Element>

const DAY = 86_400_000
const BASE = Date.UTC(2026, 6, 27, 9, 0, 0)

/**
 * Seed the three stores the timeline reads. `save` is stubbed so toggling the
 * grip re-renders without reaching Dexie/Tauri, and `jumpToMessage` returns
 * true so row clicks resolve instead of falling through to the DOM path (in the
 * app it is registered by MessageList).
 */
function seed({
  expanded,
  bookmarkedIds = [],
  reduce = false,
}: {
  expanded: boolean
  bookmarkedIds?: string[]
  reduce?: boolean
}) {
  return async () => {
    useSettingsStore.setState({
      settings: {
        conversationTimeline: { enabled: true, expanded },
        motion: { speed: 1, reduce },
      } as AppSettings,
      save: async () => {},
    })
    useChatStore.setState({ bookmarkedIds })
    useChatViewportStore.setState({ jumpToMessage: () => true })
  }
}

// The timeline measures a scroll container via `scrollRef`. A render wrapper
// owns that ref + a tall scrollable body with the anchored `data-msg-id` nodes,
// and sits beside the timeline so the lane is visible.
function TimelineHarness({ messages }: { messages: UIMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div className="@container/message-list flex h-[80vh] w-full overflow-hidden border">
      <div ref={scrollRef} role="log" className="min-w-0 flex-1 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} data-msg-id={m.id} className="mb-24 rounded border bg-card p-3 text-sm">
            <span className="text-muted-foreground">{m.role}: </span>
            {(m.parts[0] as { text?: string }).text}
          </div>
        ))}
      </div>
      <ConversationTimeline
        messages={messages}
        scrollRef={scrollRef}
        virtualizer={NULL_VIRTUALIZER}
        virtualize={false}
      />
    </div>
  )
}

const CONVERSATION: UIMessage[] = [
  userTurn("u1", "What are the limits of static export?", 1_700_000_000_000),
  reply("a1", "No runtime server."),
  userTurn("u2", "Where does backend logic live then?", 1_700_000_100_000),
  reply("a2", "Tauri Rust side."),
  userTurn("u3", "Can mobile use it too?", 1_700_000_200_000),
  reply("a3", "Via Capacitor plugins."),
]

/** A transcript spread over three days, so the panel's date headers separate something. */
function acrossDays(turns: number): UIMessage[] {
  return Array.from({ length: turns }, (_, i) => {
    const at = BASE + Math.floor(i / 4) * DAY + i * 7 * 60_000
    return [
      userTurn(`u${i}`, `Question number ${i + 1} about the architecture`, at),
      reply(`a${i}`, `Answer ${i + 1}`, at + 60_000),
    ]
  }).flat()
}

const meta = {
  title: "Chat/Minimap/ConversationTimeline",
  component: ConversationTimeline,
  parameters: { layout: "fullscreen" },
  // The interesting surface needs a real scroll container + ref, so every story
  // renders via TimelineHarness. These default args only satisfy the required
  // prop types; each story's `render` ignores them.
  args: {
    messages: CONVERSATION,
    scrollRef: { current: null },
    virtualizer: NULL_VIRTUALIZER,
    virtualize: false,
  },
  beforeEach: seed({ expanded: false }),
  render: () => <TimelineHarness messages={CONVERSATION} />,
} satisfies Meta<typeof ConversationTimeline>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Collapsed rail with three user-turn markers, in its own lane beside the
 * column. Hover the rail to scrub; the grip is faintly visible at rest rather
 * than fully transparent, so there is something to discover.
 */
export const CollapsedRail: Story = {
  render: () => <TimelineHarness messages={CONVERSATION} />,
}

/** A longer conversation packs more markers onto the rail. */
export const ManyTurns: Story = {
  render: () => <TimelineHarness messages={acrossDays(12)} />,
}

/**
 * The expanded panel. It opens centred on the turn being read — in a long
 * conversation the one thing the reader already knows is where they are, and
 * that is what it used to fail to show. Sticky headers mark each calendar day,
 * since a column of bare clock times says nothing about a chat resumed across
 * days.
 */
export const ExpandedPanel: Story = {
  beforeEach: seed({ expanded: true }),
  render: () => <TimelineHarness messages={acrossDays(12)} />,
}

/**
 * A starred assistant reply. The row now points at THAT reply and labels it as
 * such — the turn counted as bookmarked before, but the panel only ever
 * displayed and jumped to the user message, so the one thing you bookmarked was
 * the one thing the bookmark could not reach.
 */
export const BookmarkedAssistantReply: Story = {
  beforeEach: seed({ expanded: true, bookmarkedIds: ["a2", "a4"] }),
  render: () => <TimelineHarness messages={acrossDays(12)} />,
}

/** Past the panel's own virtualization threshold (40 turns). */
export const LongConversation: Story = {
  beforeEach: seed({ expanded: true, bookmarkedIds: ["a11"] }),
  render: () => <TimelineHarness messages={acrossDays(60)} />,
}

/** Row reveal is skipped; the panel still opens at the active turn. */
export const ReducedMotion: Story = {
  beforeEach: seed({ expanded: true, reduce: true }),
  render: () => <TimelineHarness messages={acrossDays(12)} />,
}
