import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"
import { fn } from "storybook/test"

import { RunPanel } from "./run-panel"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"

// The durable "second clock" docked onto the composer's top edge: collapsed it
// shows Working · elapsed · tool count · newest running tool; expanded it shows
// the turn's Plan / Tools / Sub-agents / Summary. Mounts while busy or when the
// last turn is replayable. Interrupting is the composer's Stop button.
const SID = "demo-session"

type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

const assistantWithTools = (): UIMessage =>
  ({
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-Read",
        toolCallId: "c1",
        state: "output-available",
        input: { file_path: "app/page.tsx" },
        output: "export default function Home() {}",
      },
      {
        type: "tool-Grep",
        toolCallId: "c2",
        state: "output-available",
        input: { pattern: "usePlatform" },
        output: "hooks/use-platform.ts",
      },
      { type: "text", text: "Here is what I found.", state: "done" },
    ],
  }) as unknown as UIMessage

const seed = (messages: UIMessage[], status: ChatStatus) => () => {
  resetStore(useChatStore)
  const s = useChatStore.getState()
  s.setActiveSession(SID)
  s.replaceSessionMessages(SID, messages)
  if (status !== "idle") s.setSessionStatus(SID, status)
}

const meta = {
  title: "Chat/RunPanel",
  component: RunPanel,
  parameters: { layout: "fullscreen" },
  args: { sessionId: SID, onSteerNow: fn(), onSteerFlush: fn() },
  beforeEach: seed([assistantWithTools()], "streaming"),
} satisfies Meta<typeof RunPanel>

export default meta
type Story = StoryObj<typeof meta>

/** Busy: "Working", elapsed timer, tool count; the summary line expands it. */
export const Working: Story = {}

/** Awaiting approval — the verb switches and the clock freezes. */
export const AwaitingApproval: Story = {
  beforeEach: seed([assistantWithTools()], "awaiting_approval"),
}

/** Idle with a replayable record — the collapsed "Last run" bar. */
export const LastRunReplay: Story = {
  beforeEach: seed([assistantWithTools()], "idle"),
}
