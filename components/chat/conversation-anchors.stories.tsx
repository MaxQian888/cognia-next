import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import type { Virtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"

import { ConversationJumpPill, resolveJumpPillMode } from "./conversation-jump-pill"
import { JumpFlash } from "./jump-flash"
import { ConversationTimeline } from "./minimap/conversation-timeline"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import type { AppSettings } from "@cognia/agent-config-types"

/**
 * The whole anchoring module in one frame: the timeline rail in its own lane on
 * the right, the jump pill floating at the foot of the pane, and the landing
 * mark on whichever row was last jumped to.
 *
 * The point of showing them together is the layering that the individual
 * stories cannot: the pill is a sibling of the scroll container, NOT a child of
 * it. As an `absolute bottom-4` child it was positioned against the unscrolled
 * box and scrolled away with the messages — invisible exactly when it exists,
 * since it only appears once the user has scrolled up. Scroll the column here
 * and watch it stay put.
 */

const DAY = 86_400_000
const BASE = Date.UTC(2026, 6, 27, 9, 0, 0)
const NULL_VIRTUALIZER = null as unknown as Virtualizer<HTMLDivElement, Element>

const QUESTIONS = [
  "Why is the deploy step retrying three times?",
  "Show me the retry backoff config.",
  "What happens if the third attempt also fails?",
  "Does that path emit a metric anywhere?",
  "Add an alert for it.",
  "Where should the alert threshold sit?",
  "Let's revisit the rollback plan.",
  "Does rollback need the same alert?",
]

function buildMessages(turns: number): UIMessage[] {
  return Array.from({ length: turns }, (_, i) => {
    const at = BASE + Math.floor(i / 4) * DAY + i * 7 * 60_000
    return [
      {
        id: `u-${i}`,
        role: "user",
        parts: [{ type: "text", text: QUESTIONS[i % QUESTIONS.length]! }],
        metadata: { createdAt: at },
      },
      {
        id: `a-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Answer ${i + 1}. ${"detail ".repeat(18)}` }],
        metadata: { createdAt: at + 60_000 },
      },
    ] as unknown as UIMessage[]
  }).flat()
}

const MESSAGES = buildMessages(14)

function seed({ expanded = false, reduce = false } = {}) {
  return async () => {
    useSettingsStore.setState({
      settings: {
        conversationTimeline: { enabled: true, expanded },
        motion: { speed: 1, reduce },
      } as AppSettings,
      save: async () => {},
    })
    useChatStore.setState({ bookmarkedIds: ["a-3"] })
    useChatViewportStore.setState({ jumpToMessage: () => true })
  }
}

/**
 * A working stand-in for the message pane. It drives the same three inputs the
 * real `resolveJumpPillMode` consumes — at-bottom, a return offer, and unread
 * count — off actual scrolling, so the pill's states can be produced by hand.
 */
function AnchorsHarness({ startAtTop = false }: { startAtTop?: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = React.useState(!startAtTop)
  const [returnTo, setReturnTo] = React.useState<number | null>(null)
  const [newMessageCount, setNewMessageCount] = React.useState(0)
  const [landed, setLanded] = React.useState<{ id: string; nonce: number } | null>(null)

  React.useEffect(() => {
    if (startAtTop) scrollRef.current?.scrollTo({ top: 0 })
  }, [startAtTop])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setAtBottom(bottom)
    if (bottom) setNewMessageCount(0)
  }

  const jumpTo = (id: string) => {
    const el = scrollRef.current
    if (!el) return
    setReturnTo(el.scrollTop)
    el.querySelector(`[data-msg-id="${id}"]`)?.scrollIntoView({ block: "start" })
    setLanded((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const mode = resolveJumpPillMode({ atBottom, canReturn: returnTo != null, newMessageCount })

  return (
    <div className="w-[900px] space-y-3">
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          className="rounded border border-border px-2 py-1"
          onClick={() => jumpTo("u-4")}
        >
          Jump to turn 5
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1"
          onClick={() => setNewMessageCount((n) => n + 1)}
        >
          Simulate a new reply
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1"
          onClick={() => setReturnTo(null)}
        >
          Expire the return offer
        </button>
      </div>

      {/* Mirrors MessageList's own nesting, which is load-bearing for both
          fixes: the pill is a SIBLING of the scroll container (not a child, or
          it scrolls away with the messages), and the timeline rail is a sibling
          of the message LANE (not of the scroller), so the pill centres over the
          reading column rather than over the column plus a 256px panel. */}
      <div className="@container/message-list relative flex h-[560px] overflow-hidden rounded-lg border border-border">
        <div className="relative flex min-w-0 flex-1">
          <div
            ref={scrollRef}
            role="log"
            onScroll={onScroll}
            className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4"
          >
            {MESSAGES.map((m) => (
              <div key={m.id} data-msg-id={m.id} className="relative rounded-md p-3">
                {landed?.id === m.id ? <JumpFlash nonce={landed.nonce} holdMs={1200} /> : null}
                <p
                  className={
                    m.role === "user" ? "text-sm font-medium" : "text-sm text-muted-foreground"
                  }
                >
                  {(m.parts[0] as { text?: string }).text}
                </p>
              </div>
            ))}
          </div>

          <ConversationJumpPill
            mode={mode}
            newMessageCount={newMessageCount}
            onReturn={() => {
              if (returnTo != null) scrollRef.current?.scrollTo({ top: returnTo })
              setReturnTo(null)
            }}
            onToBottom={() => {
              const el = scrollRef.current
              if (el) el.scrollTop = el.scrollHeight
              setNewMessageCount(0)
            }}
          />
        </div>

        <ConversationTimeline
          messages={MESSAGES}
          scrollRef={scrollRef}
          virtualizer={NULL_VIRTUALIZER}
          virtualize={false}
        />
      </div>
    </div>
  )
}

const meta = {
  title: "Chat/ConversationAnchors",
  parameters: { layout: "centered" },
  beforeEach: seed(),
} satisfies Meta<typeof AnchorsHarness>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Parked at the newest turn. The rail holds its lane, and the pill is absent —
 * there is nothing to offer, so it is not rendered rather than disabled.
 */
export const AtLatest: Story = {
  render: () => <AnchorsHarness />,
}

/**
 * Scrolled up. Scroll the column by hand and the pill stays anchored to the
 * pane, which is the regression this whole change exists to fix.
 */
export const ScrolledUp: Story = {
  render: () => <AnchorsHarness startAtTop />,
}

/** With the panel open, so the reading column, the panel and the pill coexist. */
export const WithTimelineOpen: Story = {
  beforeEach: seed({ expanded: true }),
  render: () => <AnchorsHarness startAtTop />,
}

/** All animation collapsed: reveal, pill transition and landing mark alike. */
export const ReducedMotion: Story = {
  beforeEach: seed({ expanded: true, reduce: true }),
  render: () => <AnchorsHarness startAtTop />,
}
