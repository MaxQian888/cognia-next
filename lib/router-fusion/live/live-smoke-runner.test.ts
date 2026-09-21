/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { DEFAULT_RUN_CAP_USD_BY_MODE, FakeProvider } from "@cognia/router-fusion"
import { LiveCapError, planLiveSmokeCaps } from "@cognia/router-fusion/live/cap"
import { LIVE_SMOKE_CASES } from "@cognia/router-fusion/live/cases"
import {
  SIMULATED_PROVIDER_ID,
  simulatedProviderListing,
  simulatedStep,
} from "@cognia/router-fusion/live/simulated"

import { FusionLedgerStore } from "../db/ledger-store"
import type { ChatRouteHost } from "../chat/route-chat-turn"
import {
  createLiveRouteHost,
  missingCredentials,
  previewLiveSmoke,
  runLiveSmoke,
  type RunLiveSmokeInput,
} from "./live-smoke-runner"
import { parseSettingsExport, prepareLiveSettings } from "./live-smoke-settings"
import { installNetworkGuard, type NetworkGuard } from "./network-guard"
import { createSimulatedRouteHost, simulatedAppSettings } from "./simulated-route-host"

const PLAN = planLiveSmokeCaps(LIVE_SMOKE_CASES, DEFAULT_RUN_CAP_USD_BY_MODE)
let databases = 0
let network: NetworkGuard

beforeEach(() => {
  network = installNetworkGuard("block", { now: () => Date.now() })
})

afterEach(() => {
  network.restore()
  jest.restoreAllMocks()
})

function simulated(overrides: Partial<RunLiveSmokeInput> = {}) {
  const appSettings = simulatedAppSettings()
  const executor = new FakeProvider((request) => simulatedStep(request))
  const input: RunLiveSmokeInput = {
    label: "simulated",
    appSettings,
    routeHost: createSimulatedRouteHost(appSettings, {
      now: () => Date.now(),
      newId: () => globalThis.crypto.randomUUID(),
    }),
    executor,
    plan: PLAN,
    providers: [simulatedProviderListing()],
    allowedProviderIds: [SIMULATED_PROVIDER_ID],
    fixtureRoot: "/tmp/fixture",
    network,
    databaseName: `live-smoke-test-${++databases}`,
    sleep: async () => {},
    ...overrides,
  }
  return { input, executor }
}

describe("runLiveSmoke (simulated)", () => {
  it("runs every case through the router, the ledger and the orchestrator, and reports what the ledger booked", async () => {
    const { input, executor } = simulated()
    const report = await runLiveSmoke(input)

    expect(report).toMatchObject({
      label: "simulated",
      budgetMode: "strict",
      totalCapMicrousd: 5_000_000,
      plannedMicrousd: 4_800_000,
      capEnforcement: { ledgerProbe: "refused_over_cap" },
      network: { mode: "blocked", requests: 0, blocked: 0 },
      fixtureRoot: "/tmp/fixture",
    })
    expect(report.disclaimer).toMatch(/^SIMULATED/)
    const byId = Object.fromEntries(report.cases.map((entry) => [entry.id, entry]))
    expect(byId.direct).toMatchObject({
      outcome: "succeeded",
      route: { actionId: "direct_baseline", roles: { solver: "fake::mock/baseline-v1" } },
      result: { qualityStatus: "accepted", verificationStatus: "passed" },
      costStatus: "actual",
    })
    expect(byId.cascade).toMatchObject({
      outcome: "succeeded",
      route: { actionId: "cascade_schema" },
      result: { qualityStatus: "accepted" },
    })
    // No evidence tool on this host: the panel is a labelled degraded result.
    expect(byId.panel).toMatchObject({
      outcome: "succeeded",
      route: { actionId: "panel_review" },
      result: { qualityStatus: "degraded", verificationStatus: "inconclusive" },
    })
    expect(byId.delegate).toMatchObject({
      outcome: "skipped",
      detail: "skipped: delegate not available in this build",
      runId: null,
      spentMicrousd: 0,
    })
    expect(byId.delegate.reasons).toEqual(
      expect.arrayContaining(["delegate_code:SANDBOX_UNAVAILABLE"])
    )

    // Every call was reserved by the ledger, carries a request id and usage buckets.
    for (const entry of [byId.direct, byId.cascade, byId.panel]) {
      expect(entry.calls.length).toBeGreaterThan(0)
      expect(entry.retry).toMatchObject({
        unledgeredCalls: 0,
        httpRequests: 0,
        extraHttpRequests: 0,
      })
      expect(entry.retry.executorCalls).toBe(entry.calls.length)
      for (const call of entry.calls) {
        expect(call.providerRequestId).toMatch(/^mock:/)
        expect(call.state).toBe("SUCCEEDED")
        expect(call.usage?.output).toBeGreaterThan(0)
      }
      expect(entry.spentMicrousd).toBe(
        entry.calls.reduce((sum, call) => sum + (call.actualMicrousd ?? 0), 0)
      )
      expect(entry.effects.usage_row).toBe(entry.calls.length)
      expect(entry.events["run.completed"]).toBe(1)
    }
    expect(report.totalSpentMicrousd).toBe(
      byId.direct.spentMicrousd + byId.cascade.spentMicrousd + byId.panel.spentMicrousd
    )
    expect(report.remainingMicrousd).toBe(5_000_000 - report.totalSpentMicrousd)
    expect(executor.requests).toHaveLength(
      byId.direct.calls.length + byId.cascade.calls.length + byId.panel.calls.length
    )
    expect(report.capabilities.map((row) => row.requestIds)).toEqual(["all", "all", "all"])
    expect(network.records).toHaveLength(0)
  })

  it("lets the ledger refuse a case that no longer fits the total, sending nothing for it", async () => {
    const { input, executor } = simulated({
      plan: planLiveSmokeCaps(LIVE_SMOKE_CASES, DEFAULT_RUN_CAP_USD_BY_MODE, 500_000),
    })
    const report = await runLiveSmoke(input)
    expect(report.cases.map((entry) => [entry.id, entry.outcome])).toEqual([
      ["direct", "succeeded"],
      ["cascade", "refused"],
      ["panel", "refused"],
      ["delegate", "skipped"],
    ])
    expect(report.cases[1].detail).toBe("refused by the ledger: TENANT_BUDGET_EXHAUSTED")
    expect(new Set(executor.requests.map((request) => request.logicalStepId))).toEqual(
      new Set(["direct:solver"])
    )
    expect(report.totalSpentMicrousd).toBeLessThanOrEqual(500_000)
  })

  it("refuses to start when the ledger does not refuse a run over the total", async () => {
    const createRun = jest
      .spyOn(FusionLedgerStore.prototype, "createRun")
      .mockResolvedValueOnce({ ok: true, run: {} as never })
    const { input, executor } = simulated()
    const error = await runLiveSmoke(input).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(LiveCapError)
    expect((error as LiveCapError).code).toBe("CAP_NOT_ENFORCED_BY_LEDGER")
    expect(createRun).toHaveBeenCalledTimes(1)
    expect(executor.requests).toHaveLength(0)
  })

  it("refuses a route that pins a provider the user did not confirm", async () => {
    const { input, executor } = simulated({ allowedProviderIds: ["anthropic"] })
    const report = await runLiveSmoke(input)
    expect(report.cases.map((entry) => entry.outcome)).toEqual([
      "refused",
      "refused",
      "refused",
      "skipped",
    ])
    expect(report.cases[0].reasons).toEqual(["PROVIDER_NOT_CONFIRMED:fake::mock/baseline-v1"])
    expect(report.capEnforcement.ledgerProbe).toBe("not_reached")
    expect(executor.requests).toHaveLength(0)
  })

  it("stops at an unexpected error and reports the cases after it as not run", async () => {
    const { input, executor } = simulated()
    const routeHost: ChatRouteHost = {
      ...input.routeHost,
      planRoute: async () => {
        throw new Error("engine exploded")
      },
    }
    const report = await runLiveSmoke({ ...input, routeHost })
    expect(report.cases.map((entry) => entry.outcome)).toEqual([
      "error",
      "not_run",
      "not_run",
      "not_run",
    ])
    expect(report.cases[0].error).toEqual({ code: "Error", message: "engine exploded" })
    expect(report.cases[1].detail).toBe("not run: the smoke stopped at direct")
    expect(executor.requests).toHaveLength(0)
  })
})

const LIVE_EXPORT = {
  schema: "cognia-settings",
  version: 1,
  settings: {
    providerSettings: {
      openai: {
        providerId: "openai",
        enabled: true,
        defaultModel: "gpt-4o-mini",
        enabledModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
        discoveredModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"].map((id) => ({
          id,
          supportsStructuredOutput: true,
          supportsTools: true,
          contextLength: 128_000,
          maxOutputTokens: 16_384,
        })),
      },
    },
    modelMappings: [
      ["fast", "gpt-4o-mini"],
      ["balanced", "gpt-4.1-mini"],
      ["powerful", "gpt-4o"],
    ].map(([alias, modelId]) => ({
      id: `m-${alias}`,
      alias,
      providers: [{ providerId: "openai", modelId }],
      distribution: "priority",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    })),
  },
}

describe("runLiveSmoke (live composition, fake executor: nothing is sent)", () => {
  const base = parseSettingsExport(JSON.stringify(LIVE_EXPORT))

  it("routes the user's providers through the app's routing engine and prices calls by their rate cards", async () => {
    const prepared = prepareLiveSettings(base, {
      env: { COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-test-not-used" },
      requestedProviders: null,
    })
    const executor = new FakeProvider((request) => simulatedStep(request))
    const report = await runLiveSmoke({
      label: "live",
      appSettings: prepared.appSettings,
      routeHost: createLiveRouteHost(prepared.appSettings),
      executor,
      plan: PLAN,
      providers: prepared.providers,
      allowedProviderIds: prepared.selected,
      fixtureRoot: null,
      network,
      databaseName: `live-smoke-test-${++databases}`,
      sleep: async () => {},
    })
    expect(report.label).toBe("live")
    expect(report.disclaimer).toMatch(/^LIVE/)
    const direct = report.cases[0]
    expect(direct).toMatchObject({
      outcome: "succeeded",
      route: { actionId: "direct_baseline", roles: { solver: "openai::gpt-4o" } },
      costStatus: "actual",
    })
    expect(direct.spentMicrousd).toBeGreaterThan(0)
    expect(report.cases.find((entry) => entry.id === "delegate")?.outcome).toBe("skipped")
    expect(executor.requests.every((request) => request.deploymentId.startsWith("openai::"))).toBe(
      true
    )
    expect(report.providers.find((provider) => provider.id === "openai")?.selected).toBe(true)
  })

  it("names the pinned deployments this host has no credential for", () => {
    const withKey = prepareLiveSettings(base, {
      env: { COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-test-not-used" },
      requestedProviders: null,
    })
    const withoutKey = prepareLiveSettings(base, { env: {}, requestedProviders: ["openai"] })
    const roles = { solver: "openai::gpt-4o" }
    expect(missingCredentials(withKey.appSettings, roles)).toEqual([])
    expect(missingCredentials(withoutKey.appSettings, roles)).toEqual(["openai::gpt-4o"])
    expect(missingCredentials(withKey.appSettings, { solver: "not-a-deployment" })).toEqual([
      "not-a-deployment",
    ])
  })
})

describe("previewLiveSmoke", () => {
  it("routes every case without creating a run or calling anything", async () => {
    const { input, executor } = simulated()
    const previews = await previewLiveSmoke({
      routeHost: input.routeHost,
      appSettings: input.appSettings,
      plan: PLAN,
      allowedProviderIds: [SIMULATED_PROVIDER_ID],
      checkCredentials: false,
    })
    expect(previews.map((preview) => [preview.caseId, preview.status, preview.actionId])).toEqual([
      ["direct", "selected", "direct_baseline"],
      ["cascade", "selected", "cascade_schema"],
      ["panel", "selected", "panel_review"],
      ["delegate", "skipped", null],
    ])
    expect(previews[0].reserveMicrousd).toBeGreaterThan(0)
    expect(previews[0].unconfirmed).toEqual([])
    expect(executor.requests).toHaveLength(0)
  })

  it("reports a routing exception on one line instead of throwing", async () => {
    const { input } = simulated()
    const previews = await previewLiveSmoke({
      routeHost: {
        ...input.routeHost,
        planRoute: async () => {
          throw new Error("line one\n  line two")
        },
      },
      appSettings: input.appSettings,
      plan: PLAN,
      allowedProviderIds: null,
      checkCredentials: false,
    })
    expect(previews[0]).toMatchObject({
      status: "error",
      detail: "routing failed: Error: line one line two",
    })
  })
})
