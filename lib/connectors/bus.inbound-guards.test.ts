/** @jest-environment jsdom */
/**
 * Integration tests for the two inbound guards that run on the bus after the
 * routing decision: the sibling-bot anti-loop guard (step 9.6) and the media
 * model gate (step 9.7).
 *
 * Both live here rather than in the transport gate for the same reason — a
 * decision about what a MODEL may see is only meaningful once a model is going
 * to run at all, and taking it must not cost the message its place in history.
 *
 * The guard used to live in the transport gate (`at-gate.ts`), ahead of the
 * durable inbound insert and ahead of the routing decision. Two consequences,
 * both pinned here:
 *
 *   (a) a suppressed message left NO history — the bot silently discarded it
 *       before anything was written down;
 *   (b) the per-chat interplay budget was spent before anything had decided
 *       the message would be answered, so a sibling posting into a chat whose
 *       trigger matched nothing still burned budget.
 *
 * The guard now runs after both, so a suppressed message is recorded as
 * history-only with a precise reason, and budget is only spent on a response
 * that is genuinely about to be enqueued.
 */

import "fake-indexeddb/auto"

// Same deterministic stand-ins bus.runtime.test.ts uses: the PII heuristics,
// plugin decision hook, follow-up control and OCR all have their own suites,
// and leaving them live makes this file a test of those instead of the guard.
const mockConnectorDecision = jest.fn(async () => ({ decision: "allow" as const }))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchConnectorDecision: mockConnectorDecision }),
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
// The consent card's own projection (bindings + outbound enqueue) has its own
// suite; here only the bus's decision to ASK is under test.
const mockRequestMediaGrant = jest.fn(async (_input: unknown) => undefined)
jest.mock("@/lib/connectors/hitl/media-grant", () => ({
  ...jest.requireActual("@/lib/connectors/hitl/media-grant"),
  requestMediaGrant: (input: unknown) => mockRequestMediaGrant(input),
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { listRecent } from "@/lib/db/connector-audit"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import { __resetSiblingBotCacheForTesting, type SiblingClassification } from "./sibling-bots"
import { __resetSiblingInterplayBudgetForTesting } from "./at-gate"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { TriggerPolicy } from "@/types/connectors/policy"

/** Matches every event these tests send, so routing never masks the guard. */
const ALWAYS_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
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

function groupEvent(
  adapterId: string,
  messageId: string,
  chatId = "chatA"
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:${chatId}`,
    sender: { id: "u_peer", platform: "telegram", adapterId, remoteUserId: "u_peer" },
    channel: { id: `ch_${chatId}`, kind: "group" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: true, users: [] },
    timestamp: Date.now(),
    raw: {},
    kind: "create",
  }
}

function imageEvent(
  adapterId: string,
  messageId: string,
  over: { dataBase64?: string; ocrText?: string } = {}
): NormalizedInboundEvent {
  const base = groupEvent(adapterId, messageId)
  return {
    ...base,
    segments: [
      {
        type: "image",
        url: "",
        dataBase64: over.dataBase64 ?? "SECRETBYTES",
        mimeType: "image/png",
        ...(over.ocrText ? { ocrText: over.ocrText } : {}),
      },
    ] as NormalizedInboundEvent["segments"],
    plainText: "",
  }
}

async function seedAdapter(over: Partial<AdapterInstanceRow> = {}): Promise<string> {
  const row = await createAdapterInstance({
    type: "telegram",
    displayName: "Guard Bot",
    enabled: true,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: ALWAYS_TRIGGER,
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    ...over,
  })
  getBus().registerAdapter(makeAdapter(row.id))
  return row.id
}

/** Force the classifier's answer without seeding a second real instance. */
let classification: SiblingClassification = { kind: "not_sibling" }
jest.mock("./sibling-bots", () => {
  const actual = jest.requireActual("./sibling-bots")
  return {
    ...actual,
    classifySiblingSender: jest.fn(async () => classification),
  }
})

async function auditKinds(): Promise<string[]> {
  // `listRecent`'s first argument is an adapter id, not a limit.
  const rows = await listRecent(undefined, 50)
  return rows.map((r) => r.kind)
}

/**
 * `markConnectorInboundJobHistoryOnly` records the reason on `recoveryReason`
 * alongside `status: "history_only"` — that pair is what makes a suppressed
 * message explainable after the fact.
 */
async function historyOnlyReasons(): Promise<(string | undefined)[]> {
  const jobs = await getDb().connectorInboundJobs.toArray()
  return jobs.filter((j) => j.status === "history_only").map((j) => j.recoveryReason)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  __resetSiblingBotCacheForTesting()
  __resetSiblingInterplayBudgetForTesting()
  classification = { kind: "not_sibling" }
}, 30_000)

describe("sibling guard — suppression still leaves history", () => {
  it("ignores a sibling message but records it as history-only with a reason", async () => {
    const adapterId = await seedAdapter({ siblingBotPolicy: "ignore" })
    const bus = getBus()
    const handler = jest.fn()
    bus.routeHandler = handler
    classification = {
      kind: "sibling",
      row: { id: "tg-sibling" } as AdapterInstanceRow,
    }

    await bus.dispatchInboundFull(groupEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(handler).not.toHaveBeenCalled()
    expect(await auditKinds()).toContain("inbound.sibling_bot_ignored")
    // The message is still on the record — this is the regression the old
    // placement caused, and the reason a user could not see why nothing
    // happened.
    expect(await getDb().connectorInboundJobs.count()).toBe(1)
    expect(await historyOnlyReasons()).toEqual(["sibling_bot_ignored"])
  })

  it("fails closed on an unidentifiable sender and names the instances to fix", async () => {
    const adapterId = await seedAdapter({ siblingBotPolicy: "ignore" })
    const bus = getBus()
    const handler = jest.fn()
    bus.routeHandler = handler
    classification = { kind: "identity_unknown", unverifiedAdapterIds: ["wecom-x"] }

    await bus.dispatchInboundFull(groupEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(handler).not.toHaveBeenCalled()
    expect(await historyOnlyReasons()).toEqual(["sibling_identity_unknown"])
    const rows = await listRecent(undefined, 50)
    const audit = rows.find((r) => r.kind === "inbound.sibling_identity_unknown")
    expect(audit?.fields).toEqual({ unverifiedAdapterIds: ["wecom-x"] })
  })

  it("lets an ordinary message through untouched", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const handler = jest.fn()
    bus.routeHandler = handler

    await bus.dispatchInboundFull(groupEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(await auditKinds()).not.toContain("inbound.sibling_bot_ignored")
  })
})

describe("sibling guard — the interplay budget is only spent on a real response", () => {
  it("spends exactly one slot per answered sibling message, then stops", async () => {
    const adapterId = await seedAdapter({
      siblingBotPolicy: "respond",
      botInterplayBudget: 2,
    })
    const bus = getBus()
    const handler = jest.fn()
    bus.routeHandler = handler
    classification = {
      kind: "sibling",
      row: { id: "tg-sibling" } as AdapterInstanceRow,
    }

    for (const id of ["m1", "m2", "m3"]) {
      await bus.dispatchInboundFull(groupEvent(adapterId, id))
    }
    await bus.flushInboundTurns()

    expect(handler).toHaveBeenCalledTimes(2)
    expect(await auditKinds()).toContain("inbound.sibling_bot_budget_exhausted")
    expect(await historyOnlyReasons()).toContain("sibling_bot_budget_exhausted")
  })

  it("does not spend budget on a message the router drops", async () => {
    // A trigger that matches nothing: the message is admitted and stored, but
    // no response is ever enqueued, so the guard must not have charged for it.
    const adapterId = await seedAdapter({
      siblingBotPolicy: "respond",
      botInterplayBudget: 1,
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })
    const bus = getBus()
    bus.routeHandler = jest.fn()
    classification = {
      kind: "sibling",
      row: { id: "tg-sibling" } as AdapterInstanceRow,
    }

    await bus.dispatchInboundFull(groupEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    // Nothing was answered, and the single budget slot is still available —
    // under the old placement this message had already consumed it.
    expect(await auditKinds()).not.toContain("inbound.sibling_bot_budget_exhausted")
    expect(await auditKinds()).toContain("inbound.routing_dropped")
  })
})

describe("routing drops are auditable", () => {
  it("records why an admitted message produced no answer", async () => {
    const adapterId = await seedAdapter({
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })
    const bus = getBus()
    bus.routeHandler = jest.fn()

    await bus.dispatchInboundFull(groupEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    const rows = await listRecent(undefined, 50)
    const dropped = rows.find((r) => r.kind === "inbound.routing_dropped")
    expect(dropped).toBeDefined()
    expect(dropped?.conversationKey).toBe(`telegram:${adapterId}:chatA`)
    expect(dropped?.fields).toMatchObject({ matched: false })
  })
})

describe("media model gate — the bus stamps the decision", () => {
  it("stamps local_extract_only by default and audits the withheld attachment", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const seen: NormalizedInboundEvent[] = []
    bus.routeHandler = async (event: NormalizedInboundEvent) => {
      seen.push(event)
    }

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    // The stamp is what `inboundEventToSendContent` reads; without it the
    // gate would be dead code no matter how correct the gate itself is.
    expect(seen[0]?.mediaModelPolicy).toBe("local_extract_only")
    const rows = await listRecent(undefined, 50)
    const blocked = rows.find((r) => r.kind === "inbound.media_model_blocked")
    expect(blocked?.reason).toBe("no_local_text")
    expect(blocked?.fields).toMatchObject({ segmentType: "image", policy: "local_extract_only" })
  })

  it("does not audit a withheld attachment when local text was extracted", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.routeHandler = jest.fn()

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1", { ocrText: "RECEIPT 9" }))
    await bus.flushInboundTurns()

    expect(await auditKinds()).not.toContain("inbound.media_model_blocked")
  })

  it("honours a live, provider-scoped grant on the conversation", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic" })
    const bus = getBus()
    const seen: NormalizedInboundEvent[] = []
    bus.routeHandler = async (event: NormalizedInboundEvent) => {
      seen.push(event)
    }
    await getDb().conversationOverrides.put({
      id: "ov-1",
      conversationKey: `telegram:${adapterId}:chatA`,
      mediaModelGrant: {
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(seen[0]?.mediaModelPolicy).toBe("allow_cloud_binary")
    expect(await auditKinds()).not.toContain("inbound.media_model_blocked")
  })

  it("ignores a grant that names a different provider", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic" })
    const bus = getBus()
    const seen: NormalizedInboundEvent[] = []
    bus.routeHandler = async (event: NormalizedInboundEvent) => {
      seen.push(event)
    }
    await getDb().conversationOverrides.put({
      id: "ov-1",
      conversationKey: `telegram:${adapterId}:chatA`,
      mediaModelGrant: {
        policy: "allow_cloud_binary",
        providers: ["ollama"],
        grantedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(seen[0]?.mediaModelPolicy).toBe("local_extract_only")
  })
})

/**
 * The in-chat consent card is the only thing that can turn a withheld
 * attachment into a grant, so WHEN the bus decides to ask is part of the gate.
 */
describe("media model gate — asking for consent", () => {
  /** A sender whose local identity id differs from its platform id. */
  function fromPeer(event: NormalizedInboundEvent): NormalizedInboundEvent {
    return {
      ...event,
      sender: { ...event.sender, id: "usr_local_42", remoteUserId: "tg_99887766" },
    }
  }

  it("asks once, scoped to the sender's PLATFORM id", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic" })
    const bus = getBus()
    bus.routeHandler = jest.fn()

    await bus.dispatchInboundFull(fromPeer(imageEvent(adapterId, "m1")))
    await bus.flushInboundTurns()

    expect(mockRequestMediaGrant).toHaveBeenCalledTimes(1)
    // `authorizeConnectorCallback` compares the presser against
    // `event.user.remoteUserId`, so a LOCAL identity id here denies the very
    // person whose message was blocked.
    expect(mockRequestMediaGrant).toHaveBeenCalledWith(
      expect.objectContaining({ initiatorUserId: "tg_99887766", provider: "anthropic" })
    )

    // Asked once per conversation, not once per photo.
    await bus.dispatchInboundFull(fromPeer(imageEvent(adapterId, "m2")))
    await bus.flushInboundTurns()
    expect(mockRequestMediaGrant).toHaveBeenCalledTimes(1)
  })

  // A grant the operator already wrote must not be re-asked; re-asking reads
  // as the bot forgetting. The provider mismatch is audited instead.
  it("does not ask when a live grant is already on the conversation", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic" })
    const bus = getBus()
    bus.routeHandler = jest.fn()
    await getDb().conversationOverrides.put({
      id: "ov-1",
      conversationKey: `telegram:${adapterId}:chatA`,
      mediaModelGrant: { policy: "allow_cloud_binary", providers: ["ollama"], grantedAt: 1 },
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(mockRequestMediaGrant).not.toHaveBeenCalled()
    expect(await auditKinds()).toContain("inbound.media_model_blocked")
  })

  // An EXPIRED grant is not a live one — its window is what the operator let
  // run out — so it does not suppress the ask.
  it("asks again once a grant has expired", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic" })
    const bus = getBus()
    bus.routeHandler = jest.fn()
    await getDb().conversationOverrides.put({
      id: "ov-1",
      conversationKey: `telegram:${adapterId}:chatA`,
      mediaModelGrant: {
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: 1,
        expiresAt: 2,
      },
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(mockRequestMediaGrant).toHaveBeenCalledTimes(1)
  })

  // `manual-store` means the work belongs to a person and no model will run.
  // A consent card there is a bot the operator silenced speaking up to ask
  // permission for something it will never do.
  it("stays quiet in a conversation whose turns do not run", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic", defaultMode: "manual" })
    const bus = getBus()
    bus.routeHandler = jest.fn()

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()

    expect(mockRequestMediaGrant).not.toHaveBeenCalled()
    // The gate itself still ran — the stamp has to be on the event either way.
    expect(await auditKinds()).toContain("inbound.media_model_blocked")
  })

  // A failed projection must not silence the ask for the whole process: the
  // conversation is released from the asked-set so the next photo retries.
  it("re-asks after a failed projection", async () => {
    const adapterId = await seedAdapter({ defaultProvider: "anthropic" })
    const bus = getBus()
    bus.routeHandler = jest.fn()
    mockRequestMediaGrant.mockRejectedValueOnce(new Error("delivery gateway down"))

    await bus.dispatchInboundFull(imageEvent(adapterId, "m1"))
    await bus.flushInboundTurns()
    expect(mockRequestMediaGrant).toHaveBeenCalledTimes(1)

    await bus.dispatchInboundFull(imageEvent(adapterId, "m2"))
    await bus.flushInboundTurns()
    expect(mockRequestMediaGrant).toHaveBeenCalledTimes(2)
  })
})
