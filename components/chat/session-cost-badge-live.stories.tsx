import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"

import { SessionCostBadgeLive } from "./session-cost-badge-live"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useChatStore } from "@/stores/chat"

// Store-connected wrapper around SessionCostBadge: aggregates per-message
// `metadata.usage` from the active session. Renders nothing when no message
// carries usage. Each story seeds the active session's messages.
const SID = "demo-session"

const assistantWithUsage = (id: string, usage: Record<string, number>): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: "Done.", state: "done" }],
    metadata: { usage },
  }) as unknown as UIMessage

const seed = (messages: UIMessage[]) => () => {
  resetStore(useChatStore)
  const s = useChatStore.getState()
  s.setActiveSession(SID)
  s.replaceSessionMessages(SID, messages)
}

const tokensLabel = (input: string, output: string) => `${input} in / ${output} out`

const meta = {
  title: "Chat/SessionCostBadgeLive",
  component: SessionCostBadgeLive,
  parameters: { layout: "centered" },
  args: { sessionId: SID, tokensLabel },
  beforeEach: seed([
    assistantWithUsage("a1", { inputTokens: 5000, outputTokens: 1200, totalCostUsd: 0.018 }),
    assistantWithUsage("a2", { inputTokens: 3000, outputTokens: 900, totalCostUsd: 0.011 }),
  ]),
} satisfies Meta<typeof SessionCostBadgeLive>

export default meta
type Story = StoryObj<typeof meta>

/** Two turns with usage — the badge sums them. */
export const Aggregated: Story = {}

/** A single turn. */
export const SingleTurn: Story = {
  beforeEach: seed([
    assistantWithUsage("a1", { inputTokens: 12_400, outputTokens: 3_200, totalCostUsd: 0.042 }),
  ]),
}

/** No message carries usage → the badge hides entirely. */
export const NoUsage: Story = {
  beforeEach: seed([
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi" }] } as unknown as UIMessage,
  ]),
}
