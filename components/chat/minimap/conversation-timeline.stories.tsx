import type { Meta, StoryObj } from "@storybook/nextjs"
import { useRef } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"

import { ConversationTimeline } from "./conversation-timeline"

// Right-edge conversation minimap (desktop / `lg` only). Collapsed it's a thin
// rail with proportional turn markers; the grip opens the expanded sidebar.
// Renders only when there are user turns to anchor.
const userTurn = (id: string, text: string, time: number): UIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text, state: "done" }],
    metadata: { createdAt: time },
  }) as unknown as UIMessage
const reply = (id: string, text: string): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as UIMessage

const NULL_VIRTUALIZER = null as unknown as Virtualizer<HTMLDivElement, Element>

// The timeline measures a scroll container via `scrollRef`. A render wrapper
// owns that ref + a tall scrollable body with the anchored `data-msg-id` nodes.
function TimelineHarness({ messages }: { messages: UIMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div className="relative h-[80vh] w-full border">
      <div ref={scrollRef} className="h-full overflow-y-auto p-4">
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
  render: () => <TimelineHarness messages={CONVERSATION} />,
} satisfies Meta<typeof ConversationTimeline>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed rail with three user-turn markers. Hover the rail to scrub. */
export const CollapsedRail: Story = {
  render: () => <TimelineHarness messages={CONVERSATION} />,
}

/** A longer conversation packs more markers onto the rail. */
export const ManyTurns: Story = {
  render: () => (
    <TimelineHarness
      messages={Array.from({ length: 12 }, (_, i) => [
        userTurn(
          `u${i}`,
          `Question number ${i + 1} about the architecture`,
          1_700_000_000_000 + i * 60_000
        ),
        reply(`a${i}`, `Answer ${i + 1}`),
      ]).flat()}
    />
  ),
}
