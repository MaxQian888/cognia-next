import type { Meta, StoryObj } from "@storybook/nextjs"
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { UIMessage } from "ai"
import { fn } from "storybook/test"

import { MessageList } from "./message-list"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"
import {
  createStabilityProbe,
  formatStabilityReport,
  type StabilityProbe,
} from "@/lib/chat/jitter-probe"

// The scrollable conversation body: renders each message via MessageRenderer,
// plus the thinking indicator while streaming. Reads characters from the data
// adapter and the active session id from the chat store.
const mockAdapter: DataAdapter = {
  useCharacters: () => [],
  useCharacter: () => undefined,
  useSkillsByIds: () => [],
  usePresets: () => [],
  clearMessages: async () => {},
  updateSession: async () => {},
  recordPresetUsage: async () => {},
  trustWorkspace: async () => {},
}

const withChrome = (Story: () => ReactNode) => (
  <DataAdapterProvider adapter={mockAdapter}>
    <div className="h-[80vh] w-full">
      <Story />
    </div>
  </DataAdapterProvider>
)

const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text, state: "done" }] }) as unknown as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text, state: "done" }],
  }) as unknown as UIMessage

const CONVERSATION: UIMessage[] = [
  user("u1", "What are the limits of Next.js static export?"),
  assistant("a1", "No runtime server — `app/api/`, ISR, and middleware are unavailable."),
  user("u2", "So where does backend logic live?"),
  assistant("a2", "In Tauri's Rust side (axum), or a Capacitor native plugin."),
]

const meta = {
  title: "Chat/MessageList",
  component: MessageList,
  parameters: { layout: "fullscreen" },
  decorators: [withChrome],
  args: {
    messages: CONVERSATION,
    status: "idle",
    onCopy: fn(),
    onRegenerate: fn(),
    onEditResend: fn(),
  },
  beforeEach: () => {
    resetStore(useChatStore)
    useChatStore.getState().setActiveSession("demo-session")
  },
} satisfies Meta<typeof MessageList>

export default meta
type Story = StoryObj<typeof meta>

/** A short, idle conversation. */
export const Conversation: Story = {}

/** Streaming: the last turn is the user's, so the thinking indicator shows. */
export const Thinking: Story = {
  args: {
    messages: [user("u1", "Refactor this for readability.")],
    status: "streaming",
  },
}

/** Empty list — nothing to render. */
export const Empty: Story = {
  args: { messages: [] },
}

/**
 * The jitter probe (ADR-0138).
 *
 * jsdom has no layout and `__mocks__/motion-react.js` never runs a timeline, so
 * no Jest suite can see this class of bug. This story is where it is visible:
 * it drives a fake stream at roughly one commit per frame and samples the foot
 * of the transcript every frame, then reports how many times that foot changed
 * direction. Correctly pinned, the foot holds a constant viewport position and
 * the count is zero; pin after paint instead of before it and the count climbs
 * with the frame rate.
 *
 * Use it the same way when touching anything in the reading area: run it, watch
 * the readout, expect `stable`.
 */
function StreamingJitterProbe() {
  const [text, setText] = useState("")
  const [readout, setReadout] = useState("sampling…")
  const probeRef = useRef<StabilityProbe | null>(null)

  useEffect(() => {
    probeRef.current = createStabilityProbe({
      // The foot of the transcript. Under a same-frame pin this is a constant;
      // under a post-paint pin it lurches down and snaps back every commit.
      read: () =>
        document.querySelector('[data-slot="conversation-live-tail"]')?.getBoundingClientRect()
          .bottom ?? 0,
      maxFrames: 400,
    })
    // ~1 commit per frame, which is what the rAF coalescer delivers at a real
    // 100 tok/s. Bursts of a few tokens so lines actually wrap.
    const timer = setInterval(() => {
      setText((prev) => (prev.length > 6_000 ? prev : `${prev}${STREAM_CHUNK} `))
    }, 16)
    const done = setTimeout(() => {
      clearInterval(timer)
      setReadout(formatStabilityReport(probeRef.current!.stop()))
    }, 6_000)
    return () => {
      clearInterval(timer)
      clearTimeout(done)
      probeRef.current?.stop()
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-2 font-mono text-xs" data-testid="jitter-probe-readout">
        {readout}
      </div>
      <div className="min-h-0 flex-1">
        <MessageList
          messages={[user("u1", "Explain the render path."), assistant("a1", text)]}
          status="streaming"
          onCopy={fn()}
          onRegenerate={fn()}
          onEditResend={fn()}
        />
      </div>
    </div>
  )
}

const STREAM_CHUNK =
  "The reading column pins to the foot while a turn is in flight, so appended text pushes settled content upward and the tail holds still."

export const JitterProbe: Story = {
  render: () => <StreamingJitterProbe />,
}
