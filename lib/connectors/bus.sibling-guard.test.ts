/** @jest-environment jsdom */
/**
 * Integration tests for the sibling-bot anti-loop guard in its home on the
 * bus (`bus.ts` step 9.6).
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
