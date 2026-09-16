/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings } from "@cognia/agent-config-types"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"

const engineDeps = {
  getCapabilities: () => ({ tools: true, vision: true }),
  getContextWindow: () => 200_000,
  isLocalProvider: () => false,
  getCircuitBreakerState: () => "closed" as const,
  getDeploymentCircuitBreakerState: () => "closed" as const,
  isProviderAvailable: () => true,
}
jest.mock("@cognia/provider-routing/build-preview-engine", () => ({
  buildRoutingEngineDeps: () => engineDeps,
}))

const PRICES: Record<string, { promptPer1M: number; completionPer1M: number }> = {
  "openai::gpt-5-mini": { promptPer1M: 0.1, completionPer1M: 0.4 },
}
jest.mock("@cognia/provider-core/providers/model-pricing", () => ({
  resolveModelPricing: (providerId: string, modelId: string) =>
    PRICES[`${providerId}::${modelId}`] ?? null,
}))

jest.mock("@cognia/provider-types/provider", () => ({
  ...jest.requireActual("@cognia/provider-types/provider"),
  getAllProviders: () => ({ openai: { category: "cloud" } }),
}))

jest.mock("@/lib/subscription/core/provider-registry", () => ({
  getSubscriptionProvider: () => undefined,
}))

let store: FusionLedgerStore
const drained: string[] = []
jest.mock("../chat/store-provider", () => ({
  currentFusionStore: async () => store,
  drainAccountOutbox: async (target: FusionLedgerStore) => {
    // What the account database would receive: every pending effect, applied.
    const pending = await target.db.fusionOutbox.where("status").equals("pending").toArray()
    for (const row of pending) {
      drained.push(`${row.kind}:${row.effectId}`)
      await target.db.fusionOutbox.update(row.effectId, { status: "applied" })
    }
    return { applied: pending.length, skipped: 0, failed: 0 }
  },
}))

const settingsState: { settings: AppSettings | null } = { settings: null }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

import {
  passthroughRunId,
  reservePassthroughCall,
  settlePassthroughCall,
} from "./gateway-ledger-source"

const ON = {
  routerFusion: { enabled: true, surfaces: { gatewayPassthroughLedger: true } },
} as unknown as AppSettings

let dbCounter = 0

function freshStore() {
  const name = `fusion-passthrough-test-${++dbCounter}`
  store = new FusionLedgerStore({ db: new FusionDB(name), codec: fusionContentCodec(name) })
  return store
}

function reserve(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    attempt: 0,
    providerId: "openai",
    modelId: "gpt-5-mini",
    requestedModel: "fast",
    keyId: "key-a",
    keyName: "CI robot",
    estimatedInputTokens: 800,
    ...overrides,
  } as Parameters<typeof reservePassthroughCall>[0]
}

beforeEach(() => {
  freshStore()
  settingsState.settings = ON
  drained.length = 0
})

describe("reservePassthroughCall", () => {
  it("opens one run per gateway request and reserves the attempt on it", async () => {
    const reserved = await reservePassthroughCall(reserve(), ON)
    if (reserved.kind !== "reserved") throw new Error(`refused: ${reserved.code}`)
    expect(reserved.runId).toBe(passthroughRunId("req-1"))
    const run = await store.getRun(reserved.runId)
    expect(run).toMatchObject({
      origin: "gatewayPassthrough",
      surface: "gatewayPassthroughLedger",
      status: "running",
      // Session-less on purpose: a proxied request must never make one of the
      // user's own conversations look busy.
      sessionId: null,
      actorKeyId: "key-a",
      actorKeyName: "CI robot",
    })
    const attempt = await store.db.fusionCallAttempts.get(reserved.attemptId)
    expect(attempt).toMatchObject({ state: "DISPATCHED", runId: reserved.runId })
  })

  it("keeps a failover attempt on the same run, as its own step", async () => {
    const first = await reservePassthroughCall(reserve(), ON)
    const second = await reservePassthroughCall(reserve({ attempt: 1 }), ON)
    if (first.kind !== "reserved" || second.kind !== "reserved") throw new Error("refused")
    expect(second.runId).toBe(first.runId)
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(await store.db.fusionRuns.count()).toBe(1)
    const attempts = await store.db.fusionCallAttempts.toArray()
    expect(attempts.map((a) => a.requestHash)).toHaveLength(2)
    expect(new Set(attempts.map((a) => a.requestHash)).size).toBe(2)
  })

  it("never becomes a row in the cockpit", async () => {
    // A proxy hop is one call with a price, not a task anybody is waiting to
    // read about; a row per request would bury every real run.
    await reservePassthroughCall(reserve(), ON)
    const kinds = (await store.db.fusionOutbox.toArray()).map((row) => row.kind)
    expect(kinds).not.toContain("execution_run_projection")
  })

  it("refuses without opening a run when nothing survives the hard filters", async () => {
    const restricted = {
      routerFusion: {
        enabled: true,
        surfaces: { gatewayPassthroughLedger: true },
        defaultDataClass: "restricted",
      },
      customProviders: [{ id: "openai" }],
    } as unknown as AppSettings
    const refused = await reservePassthroughCall(reserve(), restricted)
    // An aggregator whose real destination cannot be proven never gets
    // restricted data, however the request reached this machine.
    expect(refused).toMatchObject({ kind: "refused", code: "ROUTE_NO_SOLUTION" })
    expect(await store.db.fusionRuns.count()).toBe(0)
  })
})

describe("settlePassthroughCall", () => {
  it("bills the answer and seals the run when the gateway is done", async () => {
    const reserved = await reservePassthroughCall(reserve(), ON)
    if (reserved.kind !== "reserved") throw new Error("refused")
    const settled = await settlePassthroughCall({
      runId: reserved.runId,
      attemptId: reserved.attemptId,
      outcome: "succeeded",
      usage: { inputTokens: 800, outputTokens: 120 },
      final: true,
    })
    expect(settled.sealed).toBe(true)
    const run = await store.getRun(reserved.runId)
    expect(run?.status).toBe("succeeded")
    expect(run?.budget.spentMicrousd).toBeGreaterThan(0)
    // Nothing else drains for a proxy hop, so the bill reaches the account
    // database as soon as it is settled.
    expect(drained.some((entry) => entry.startsWith("usage_row:"))).toBe(true)
    expect(await store.db.fusionOutbox.where("status").equals("pending").count()).toBe(0)
  })

  it("leaves the run open while more attempts may follow", async () => {
    const reserved = await reservePassthroughCall(reserve(), ON)
    if (reserved.kind !== "reserved") throw new Error("refused")
    await settlePassthroughCall({
      runId: reserved.runId,
      attemptId: reserved.attemptId,
      outcome: "failed",
      reason: "HTTP 503",
      final: false,
    })
    expect((await store.getRun(reserved.runId))?.status).toBe("running")
    // Even a non-final settle is applied at once.
    expect(await store.db.fusionOutbox.where("status").equals("pending").count()).toBe(0)
    // The class the gateway saw is what the ledger books.
    expect((await store.db.fusionCallAttempts.get(reserved.attemptId))?.state).toBe("FAILED")
  })

  it("books a failure under the class the gateway named", async () => {
    const reserved = await reservePassthroughCall(reserve(), ON)
    if (reserved.kind !== "reserved") throw new Error("refused")
    await settlePassthroughCall({
      runId: reserved.runId,
      attemptId: reserved.attemptId,
      outcome: "failed",
      errorClass: "rate_limited",
      reason: "HTTP 429",
      final: true,
    })
    const attempt = await store.db.fusionCallAttempts.get(reserved.attemptId)
    expect(attempt?.errorClass).toBe("rate_limited")
    expect((await store.getRun(reserved.runId))?.error?.code).toBe("UPSTREAM_FAILED")
  })

  it("holds the money for a call that was sent with no answer", async () => {
    // Bytes left the machine: the bill exists and is not knowable yet, so
    // releasing the reservation would under-count real spend.
    const reserved = await reservePassthroughCall(reserve(), ON)
    if (reserved.kind !== "reserved") throw new Error("refused")
    await settlePassthroughCall({
      runId: reserved.runId,
      attemptId: reserved.attemptId,
      outcome: "unknown",
      reason: "stream stalled",
      final: true,
    })
    const run = await store.getRun(reserved.runId)
    expect(run?.status).toBe("failed")
    expect(run?.error?.code).toBe("CALL_OUTCOME_UNKNOWN")
    expect((await store.db.fusionCallAttempts.get(reserved.attemptId))?.state).toBe("UNKNOWN")
  })
})
