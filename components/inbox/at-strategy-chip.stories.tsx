import type { Meta, StoryObj } from "@storybook/nextjs"

import { AtStrategyChip } from "./at-strategy-chip"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeAdapterInstance } from "@/lib/storybook/fixtures/inbox"
import type { InboundActivationPolicy } from "@/types/connectors/policy"

const ADAPTER_ID = "story-adapter"
const CONVERSATION_KEY = `telegram:${ADAPTER_ID}:c1`

// The chip resolves the group-admission policy across both layers, so each
// story seeds the rows it is reporting on rather than passing a prop.
const meta = {
  title: "Inbox/AtStrategyChip",
  component: AtStrategyChip,
  args: { adapterId: ADAPTER_ID },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AtStrategyChip>

export default meta
type Story = StoryObj<typeof meta>

function withAdapterPolicy(inboundActivationPolicy: InboundActivationPolicy): Story["beforeEach"] {
  return async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({ id: ADAPTER_ID, inboundActivationPolicy })
      )
    })
  }
}

export const MentionEach: Story = { beforeEach: withAdapterPolicy("mention_each") }
export const MentionActivates: Story = { beforeEach: withAdapterPolicy("mention_activates") }
export const DirectOnly: Story = { beforeEach: withAdapterPolicy("direct_only") }
export const EveryMessage: Story = { beforeEach: withAdapterPolicy("always") }

/** A row predating `inboundActivationPolicy` still resolves through the same map. */
export const LegacyStrategyRow: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({ id: ADAPTER_ID, atResponseStrategy: "direct_only" })
      )
    })
  },
}

/** The conversation's own policy outranks the bot's, and the tooltip says so. */
export const ConversationOverride: Story = {
  args: { adapterId: ADAPTER_ID, conversationKey: CONVERSATION_KEY },
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.adapterInstances.put(
        makeAdapterInstance({ id: ADAPTER_ID, inboundActivationPolicy: "mention_each" })
      )
      await db.conversationOverrides.put({
        id: "co-story",
        conversationKey: CONVERSATION_KEY,
        sessionId: "ses_story",
        inboundActivationPolicy: "always",
        createdAt: 0,
        updatedAt: 0,
      })
    })
  },
}
