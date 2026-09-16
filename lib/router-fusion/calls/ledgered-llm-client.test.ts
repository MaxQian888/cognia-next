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
jest.mock("../chat/store-provider", () => ({
  currentFusionStore: async () => store,
}))

const settingsState: { settings: AppSettings | null; loaded: boolean } = {
  settings: null,
  loaded: true,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

// What a headless brain reads, since it never loads the store.
const storedSettings: { value: AppSettings | null } = { value: null }
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => storedSettings.value,
}))

import { beginLedgeredUtilityCall, utilityRouteHost } from "./ledgered-llm-client"

const ON = {
  routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
} as unknown as AppSettings

let dbCounter = 0

function freshStore() {
  const name = `fusion-ledgered-client-test-${++dbCounter}`
  store = new FusionLedgerStore({ db: new FusionDB(name), codec: fusionContentCodec(name) })
  return store
}

function call(overrides: Partial<Parameters<typeof beginLedgeredUtilityCall>[0]> = {}) {
  return {
    surface: "utilityLedger" as const,
    origin: "utility" as const,
    featureId: "conversation-title",
    providerId: "openai",
    modelId: "gpt-5-mini",
    workspaceId: null,
    prompt: "summarize this conversation",
    system: "be brief",
    maxOutputTokens: undefined,
    appSettings: ON,
    ...overrides,
  }
}

beforeEach(() => {
  freshStore()
  settingsState.settings = ON
  settingsState.loaded = true
  storedSettings.value = null
})

describe("utilityRouteHost", () => {
  it("reads every fact from where the app already keeps it", () => {
    const host = utilityRouteHost(ON)
    expect(host.environment).toBe("test")
    expect(host.pricingOf("openai", "gpt-5-mini")).toEqual({
      promptPer1M: 0.1,
      completionPer1M: 0.4,
    })
    expect(host.pricingOf("openai", "unknown-model")).toBeNull()
    expect(host.subscriptionCapable("openai")).toBe(false)
    expect(host.isAggregator("openai")).toBe(false)
    expect(host.currentSettings()).toBe(ON)
    expect(host.newId()).not.toBe(host.newId())
  })

  it("treats a user-defined endpoint like an aggregator: its destination cannot be proven", () => {
    const withCustom = {
      ...ON,
      customProviders: [{ id: "my-endpoint" }],
    } as unknown as AppSettings
    expect(utilityRouteHost(withCustom).isAggregator("my-endpoint")).toBe(true)
  })
})

describe("beginLedgeredUtilityCall", () => {
  it("opens a ledgered run for a call the settings allow", async () => {
    const grant = await beginLedgeredUtilityCall(call())
    if (grant.kind !== "granted") throw new Error(`refused: ${grant.code}`)
    const run = await store.getRun(grant.handle.runId)
    expect(run).toMatchObject({ origin: "utility", surface: "utilityLedger", status: "running" })
    expect(grant.handle.maxOutputTokens).toBeGreaterThan(0)
    await grant.handle.succeeded({ inputTokens: 500, outputTokens: 50 })
    expect((await store.getRun(grant.handle.runId))?.status).toBe("succeeded")
  })

  it("hashes the whole request, so two different prompts are two different steps", async () => {
    const first = await beginLedgeredUtilityCall(call())
    const second = await beginLedgeredUtilityCall(call({ prompt: "a different prompt" }))
    if (first.kind !== "granted" || second.kind !== "granted") throw new Error("refused")
    const attempts = await store.db.fusionCallAttempts.toArray()
    expect(attempts).toHaveLength(2)
    expect(attempts[0].requestHash).not.toBe(attempts[1].requestHash)
  })

  it("refuses without opening a run when nothing survives the hard filters", async () => {
    const restricted = {
      routerFusion: {
        enabled: true,
        surfaces: { utilityLedger: true },
        dataClassByWorkspaceId: { "ws-1": "restricted" },
      },
      customProviders: [{ id: "openai" }],
    } as unknown as AppSettings
    const grant = await beginLedgeredUtilityCall(
      call({ appSettings: restricted, workspaceId: "ws-1" })
    )
    expect(grant).toMatchObject({ kind: "refused", code: "ROUTE_NO_SOLUTION" })
    expect(await store.db.fusionRuns.count()).toBe(0)
  })

  it("refuses a call it has no settings for rather than guessing at a policy", async () => {
    settingsState.settings = null
    const grant = await beginLedgeredUtilityCall({ ...call(), appSettings: undefined })
    expect(grant).toMatchObject({ kind: "refused", code: "ROUTER_FUSION_DISABLED" })
  })

  it("falls back to the live settings store when the caller passes none", async () => {
    const grant = await beginLedgeredUtilityCall({ ...call(), appSettings: undefined })
    expect(grant.kind).toBe("granted")
  })

  it("reads the account's stored settings on a host that never loads the store", async () => {
    // A headless brain: the store is empty, the account row is not.
    settingsState.loaded = false
    settingsState.settings = null
    storedSettings.value = ON
    const grant = await beginLedgeredUtilityCall({ ...call(), appSettings: undefined })
    if (grant.kind !== "granted") throw new Error(`refused: ${grant.code}`)
    // The mid-call switch re-check (AUTH-07) must not read the empty store as
    // "off" either, or every call would be refused at dispatch.
    await grant.handle.succeeded({ inputTokens: 10, outputTokens: 5 })
    expect((await store.getRun(grant.handle.runId))?.status).toBe("succeeded")
  })
})
