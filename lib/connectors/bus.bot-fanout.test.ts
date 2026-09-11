/** @jest-environment jsdom */
/**
 * Step 11.5: an admitted inbound message reaches the Bot control plane.
 *
 * The two planes both say "bot" and are not the same thing. What is pinned
 * here is the seam between them: WHEN the connector hands a message over, and
 * when it deliberately does not.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { TriggerPolicy } from "@/types/connectors/policy"

const dispatchConnectorInboundToBots = jest.fn(
  async (
    ..._args: Parameters<
      typeof import("@/lib/bot/sources/connector-inbound").dispatchConnectorInboundToBots
    >
  ) => ({
    enqueued: [],
    rejected: [],
    unresolved: [],
  })
)

jest.mock("@/lib/bot/sources/connector-inbound", () => ({
  __esModule: true,
  dispatchConnectorInboundToBots: (...args: Parameters<typeof dispatchConnectorInboundToBots>) =>
    dispatchConnectorInboundToBots(...args),
}))

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  __esModule: true,
  findMatchingWorkflows: () => [],
}))

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

const BLOCKED_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }],
  blockers: [{ kind: "user-blocklist", userIds: ["u_alice"] }],
  storeUnmatchedInDraftMode: false,
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

function privateEvent(adapterId: string, messageId: string): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:private`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: "ch_private", kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  dispatchConnectorInboundToBots.mockClear()
}, 30_000)

async function seedAdapter(trigger: TriggerPolicy): Promise<string> {
  const row = await createAdapterInstance({
    type: "telegram",
    displayName: "Auto Bot",
    enabled: true,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger,
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
  })
  getBus().registerAdapter(makeAdapter(row.id))
  return row.id
}

describe("ConnectorBus Bot fan-out", () => {
  it("hands an admitted message to the Bot plane", async () => {
    const adapterId = await seedAdapter(AUTO_TRIGGER)
    const evt = privateEvent(adapterId, "msg_1")

    await getBus().dispatchInboundFull(evt)
    await getBus().flushInboundTurns()

    expect(dispatchConnectorInboundToBots).toHaveBeenCalledTimes(1)
    const handed = dispatchConnectorInboundToBots.mock.calls[0][0] as {
      event: NormalizedInboundEvent
    }
    expect(handed.event.messageId).toBe(evt.messageId)
    expect(handed.event.adapterId).toBe(adapterId)
  })

  it("does not hand over a message the trigger policy blocked", async () => {
    const adapterId = await seedAdapter(BLOCKED_TRIGGER)

    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_1"))
    await getBus().flushInboundTurns()

    expect(dispatchConnectorInboundToBots).not.toHaveBeenCalled()
  })

  it("survives a Bot plane that throws, because the conversation is not its problem", async () => {
    dispatchConnectorInboundToBots.mockRejectedValue(new Error("bot plane exploded"))
    const adapterId = await seedAdapter(AUTO_TRIGGER)

    await expect(
      getBus().dispatchInboundFull(privateEvent(adapterId, "msg_1"))
    ).resolves.not.toThrow()
    await getBus().flushInboundTurns()

    expect(dispatchConnectorInboundToBots).toHaveBeenCalled()
  })
})
