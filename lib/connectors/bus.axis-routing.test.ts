/** @jest-environment jsdom */
/**
 * Integration tests for the bus routing from the composition axes (ADR-0117).
 *
 * The bus used to route from `ConnectorMode` alone, through a shim that
 * hardcoded `targetKind: "direct"`. Three things were broken by that, all
 * pinned here:
 *
 *   (a) `autonomy` / `engagement` stored on a conversation changed nothing.
 *       Both non-user writers — `setAssignee` and the SLA `switchMode` step —
 *       write those fields, so the state they produce was only honoured
 *       because they ALSO write the `mode` mirror. An axis write on its own
 *       was inert.
 *   (b) `confirm` and `autopilot` have no legacy spelling, so a conversation
 *        holding either was routed by whatever `mode` happened to say.
 *   (c) a character shipping `platformDefaults.mode` was skipped entirely by
 *       the resolver, so the recommendation took effect nowhere.
 *
 * Rows carrying only the legacy `mode` must behave exactly as before — that is
 * what makes the change need no backfill, and it is asserted alongside.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchConnectorDecision: async () => ({ decision: "allow" as const }),
  }),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: () => true,
  hasNoLeakingPii: () => true,
}))
jest.mock("./follow-up-control", () => ({
  ...jest.requireActual("./follow-up-control"),
  maybeHandleRunControlFollowUp: async () => false,
  maybeHandleLarkFollowUpControl: async () => false,
}))
jest.mock("./inbound-ocr", () => ({
  ...jest.requireActual("./inbound-ocr"),
  runInboundOcr: async () => undefined,
}))
jest.mock("@/lib/governance/producers/connector", () => ({
  recordConnectorRouteGovernance: async () => "connector-decision",
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { TriggerPolicy } from "@/types/connectors/policy"
import type { RouteDecision } from "./mode-router"

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }],
  blockers: [],
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
    conversationKey: `telegram:${adapterId}:chatA`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: "ch_chatA", kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

async function seedAdapter(
  patch: Partial<Parameters<typeof createAdapterInstance>[0]> = {}
): Promise<string> {
  const row = await createAdapterInstance({
    type: "telegram",
    displayName: "Axis Bot",
    enabled: true,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: AUTO_TRIGGER,
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    ...patch,
  })
  getBus().registerAdapter(makeAdapter(row.id))
  return row.id
}

/** Dispatch one private message and report the decision the bus reached. */
async function routeOnce(adapterId: string, messageId = "m1"): Promise<RouteDecision | "none"> {
  const bus = getBus()
  let seen: RouteDecision | "none" = "none"
  bus.routeHandler = async (_event, decision) => {
    seen = decision
  }
  await bus.dispatchInboundFull(privateEvent(adapterId, messageId))
  return seen
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
}, 30_000)

describe("ConnectorBus — routing from the composition axes", () => {
  it("honours a stored autonomy that the legacy mirror contradicts", async () => {
    const adapterId = await seedAdapter()
    // Exactly the shape `setAssignee` leaves behind before its `mode` mirror
    // is read: the work belongs to a person, the mirror still says `auto`.
    await upsertByConversationKey({
      conversationKey: `telegram:${adapterId}:chatA`,
      adapterId,
      platform: "telegram",
      sessionId: "s1",
      mode: "auto",
      autonomy: "observe",
    })

    expect(await routeOnce(adapterId)).toBe("manual-store")
  })

  it("never runs a turn for work handed to a human", async () => {
    const adapterId = await seedAdapter()
    await upsertByConversationKey({
      conversationKey: `telegram:${adapterId}:chatA`,
      adapterId,
      platform: "telegram",
      sessionId: "s1",
      mode: "auto",
      autonomy: "act",
      engagement: "human",
    })

    expect(await routeOnce(adapterId)).toBe("manual-store")
  })

  it.each(["confirm", "autopilot", "act"] as const)(
    "ships the product under %s even when the legacy mirror says draft",
    async (autonomy) => {
      const adapterId = await seedAdapter()
      await upsertByConversationKey({
        conversationKey: `telegram:${adapterId}:chatA`,
        adapterId,
        platform: "telegram",
        sessionId: "s1",
        // `confirm` and `autopilot` have no legacy spelling, so an older client
        // writing the mirror can only ever say `draft` or `auto` for them.
        // Holding the product for review is `suggest`'s job alone.
        mode: "draft",
        autonomy,
      })

      expect(await routeOnce(adapterId)).toBe("ai-run")
    }
  )

  // The mirror is not ignored — it is the fallback for axes nobody set. A row
  // that says `manual` and nothing about engagement still belongs to a person.
  it("keeps deriving unset axes from the legacy mirror", async () => {
    const adapterId = await seedAdapter()
    await upsertByConversationKey({
      conversationKey: `telegram:${adapterId}:chatA`,
      adapterId,
      platform: "telegram",
      sessionId: "s1",
      mode: "manual",
      autonomy: "confirm",
    })

    expect(await routeOnce(adapterId)).toBe("manual-store")
  })

  it("holds the product for review under suggest, without a second route", async () => {
    const adapterId = await seedAdapter()
    await upsertByConversationKey({
      conversationKey: `telegram:${adapterId}:chatA`,
      adapterId,
      platform: "telegram",
      sessionId: "s1",
      autonomy: "suggest",
    })

    expect(await routeOnce(adapterId)).toBe("draft-prepare")
  })

  it("applies a character-recommended mode the resolver used to skip", async () => {
    const adapterId = await seedAdapter({ defaultCharacterId: "char_quiet" })
    await getDb().characters.put({
      id: "char_quiet",
      name: "Quiet",
      systemPrompt: "",
      platformDefaults: { mode: "manual" },
      createdAt: 1,
      updatedAt: 1,
    } as never)

    expect(await routeOnce(adapterId)).toBe("manual-store")
  })

  describe("legacy rows are unaffected", () => {
    it.each([
      ["auto", "ai-run"],
      ["draft", "draft-prepare"],
      ["manual", "manual-store"],
    ] as const)("routes a %s-only row to %s", async (mode, expected) => {
      const adapterId = await seedAdapter({ defaultMode: mode })
      expect(await routeOnce(adapterId)).toBe(expected)
    })
  })
})
