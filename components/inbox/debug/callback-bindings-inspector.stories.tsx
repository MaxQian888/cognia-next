import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { CallbackBindingsInspector } from "./callback-bindings-inspector"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeAuditEntry } from "@/lib/storybook/fixtures/inbox"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

const CONVERSATION_KEY = "slack:adapter-1:C1"
const ADAPTER_ID = "adapter-1"

// Diagnostic sheet listing A2UI callback bindings for a conversation, plus any
// recent binding-miss audit rows. Reads `connectorCallbackBindings` +
// `connectorAudit`; seed both to populate the inspector.
const meta = {
  title: "Inbox/CallbackBindingsInspector",
  component: CallbackBindingsInspector,
  args: {
    open: true,
    onOpenChange: fn(),
    conversationKey: CONVERSATION_KEY,
    adapterId: ADAPTER_ID,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CallbackBindingsInspector>

export default meta
type Story = StoryObj<typeof meta>

const binding = (over: Partial<ConnectorCallbackBindingRow>): ConnectorCallbackBindingRow => ({
  id: `${ADAPTER_ID}:act-1`,
  adapterId: ADAPTER_ID,
  actionId: "act-1",
  kind: "callback_query",
  surfaceId: "surface-1",
  conversationKey: CONVERSATION_KEY,
  createdAt: Date.now(),
  ...over,
})

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithBindings: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorCallbackBindings.bulkPut([
        binding({ id: `${ADAPTER_ID}:approve`, actionId: "approve", surfaceId: "card-1" }),
        binding({ id: `${ADAPTER_ID}:reject`, actionId: "reject", surfaceId: "card-1" }),
      ])
    })
  },
}

export const WithFailures: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorCallbackBindings.put(binding({ actionId: "approve" }))
      await db.connectorAudit.bulkPut([
        makeAuditEntry({
          adapterId: ADAPTER_ID,
          conversationKey: CONVERSATION_KEY,
          kind: "callback.unbound",
          at: Date.now() - 30_000,
        }),
        makeAuditEntry({
          adapterId: ADAPTER_ID,
          conversationKey: CONVERSATION_KEY,
          kind: "callback.handler_failed",
          at: Date.now() - 60_000,
        }),
      ])
    })
  },
}
