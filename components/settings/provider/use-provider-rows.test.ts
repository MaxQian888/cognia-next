/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import type { ProviderHealth } from "@/hooks/ai/use-provider-manager"
import type { UseProviderSettingsResult } from "@/hooks/settings/use-provider-settings"

import {
  DIAGNOSTIC_STALE_MS,
  diagnosticBadge,
  preferLiveHealth,
  useProviderRows,
} from "./use-provider-rows"

// One queue per live query in declaration order: provider samples, model
// samples, then the last-used rollup.
let liveQueryQueue: unknown[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => liveQueryQueue.shift()),
}))

jest.mock("@/lib/provider-diagnostics/store", () => ({
  queryLatestProviderDiagnosticSamples: jest.fn(),
  queryLatestProviderModelDiagnosticSamples: jest.fn(),
}))
jest.mock("@/lib/db/provider-cost-daily", () => ({ getLastUsedByProvider: jest.fn() }))

const PROVIDER_CATALOG: Record<string, unknown> = {
  openai: { id: "openai", name: "OpenAI", defaultModel: "gpt-4.1", models: [{ id: "gpt-4.1" }] },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    defaultModel: "claude-opus-5",
    models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
  },
}
jest.mock("@cognia/provider-types/provider", () => ({
  PROVIDERS: new Proxy(
    {},
    {
      get: (_t, k: string) => PROVIDER_CATALOG[k],
      has: (_t, k: string) => k in PROVIDER_CATALOG,
      ownKeys: () => Object.keys(PROVIDER_CATALOG),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }
  ),
}))
jest.mock("@cognia/provider-types", () => ({
  validateBedrockConnectionSettings: () => ({ valid: false }),
}))

jest.mock("./provider-readiness", () => ({
  getBuiltInProviderReadiness: jest.fn(() => ({ verificationStatus: null })),
  getCustomProviderReadiness: () => ({ verificationStatus: null }),
}))

jest.mock("./provider-status-utils", () => ({
  deriveStatus: () => "connected",
  isLocalEngineConfigured: () => false,
  providerMatchesCategory: (category: string, id: string) =>
    category === "flagship" ? id === "openai" : true,
  sortProviderRows: (rows: Array<{ id: string }>) =>
    [...rows].sort((a, b) => b.id.localeCompare(a.id)),
}))

function makeSettings(over: Partial<UseProviderSettingsResult> = {}): UseProviderSettingsResult {
  return {
    selectedProviderId: null,
    filteredProviders: Object.entries(PROVIDER_CATALOG),
    providerSettings: {},
    testResults: {},
    visibleCustomProviderIds: [],
    customProviders: {},
    customTestResults: {},
    ...over,
  } as unknown as UseProviderSettingsResult
}

function render(over: Partial<Parameters<typeof useProviderRows>[0]> = {}) {
  return renderHook(() =>
    useProviderRows({
      settings: makeSettings(),
      liveProviderHealth: {},
      search: "",
      categoryFilter: "all",
      sortBy: "name",
      ...over,
    })
  )
}

beforeEach(() => {
  liveQueryQueue = []
})

describe("diagnosticBadge", () => {
  const now = 1_700_000_000_000

  it("has no badge without a sample", () => {
    expect(diagnosticBadge(undefined, now)).toBeUndefined()
  })

  it("reads a completed run as passed and anything else as failed", () => {
    expect(diagnosticBadge({ status: "completed", startedAt: now }, now)).toBe("passed")
    expect(diagnosticBadge({ status: "failed", startedAt: now }, now)).toBe("failed")
  })

  // Staleness wins over the outcome: a two-hour-old pass says nothing about
  // the endpoint right now.
  it("calls a sample past the stale window stale, whatever its outcome", () => {
    const old = now - DIAGNOSTIC_STALE_MS - 1
    expect(diagnosticBadge({ status: "completed", startedAt: old }, now)).toBe("stale")
    expect(diagnosticBadge({ status: "failed", startedAt: old }, now)).toBe("stale")
  })

  it("ages from the completion time when the run finished later than it started", () => {
    const startedAt = now - DIAGNOSTIC_STALE_MS - 10_000
    expect(diagnosticBadge({ status: "completed", startedAt, completedAt: now }, now)).toBe(
      "passed"
    )
  })
})

describe("preferLiveHealth", () => {
  const health = (over: Partial<ProviderHealth>): ProviderHealth =>
    ({ totalRequests: 5, status: "healthy", ...over }) as ProviderHealth

  it("keeps the persisted result when there is no live health", () => {
    expect(preferLiveHealth(undefined, false, "failed")).toEqual({ ok: false, outcome: "failed" })
  })

  // Zero requests is not evidence of health. Letting it win would flip every
  // provider to "verified" on page load.
  it("keeps the persisted result when live health has seen no traffic", () => {
    expect(preferLiveHealth(health({ totalRequests: 0 }), false, "failed")).toEqual({
      ok: false,
      outcome: "failed",
    })
  })

  it("overrides a stale persisted failure once traffic proves the provider healthy", () => {
    expect(preferLiveHealth(health({ status: "healthy" }), false, "failed")).toEqual({
      ok: true,
      outcome: "verified",
    })
  })

  it("maps degraded to an undecided limited outcome", () => {
    expect(preferLiveHealth(health({ status: "degraded" }), true, "verified")).toEqual({
      ok: undefined,
      outcome: "limited",
    })
  })

  it("maps error to a failure", () => {
    expect(preferLiveHealth(health({ status: "error" }), true, "verified")).toEqual({
      ok: false,
      outcome: "failed",
    })
  })

  it("falls back for a status it does not recognise", () => {
    expect(preferLiveHealth(health({ status: "unknown" as never }), true, "verified")).toEqual({
      ok: true,
      outcome: "verified",
    })
  })
})

describe("useProviderRows", () => {
  it("builds one row per catalog provider", () => {
    const { result } = render()
    expect(result.current.rows.map((r) => r.id)).toEqual(["openai", "anthropic"])
    expect(result.current.rows[0]).toMatchObject({
      name: "OpenAI",
      subtitle: "gpt-4.1",
      isCustom: false,
      modelCount: 1,
    })
  })

  it("prefers the stored default model over the catalog default in the subtitle", () => {
    const { result } = render({
      settings: makeSettings({ providerSettings: { openai: { defaultModel: "o3" } } as never }),
    })
    expect(result.current.rows[0].subtitle).toBe("o3")
  })

  it("matches the search against both the id and the display name", () => {
    expect(render({ search: "anthro" }).result.current.rows.map((r) => r.id)).toEqual(["anthropic"])
    expect(render({ search: "OpenAI" }).result.current.rows.map((r) => r.id)).toEqual(["openai"])
    expect(render({ search: "  ANTHROPIC  " }).result.current.rows.map((r) => r.id)).toEqual([
      "anthropic",
    ])
    expect(render({ search: "nothing-matches" }).result.current.rows).toEqual([])
  })

  it("applies the category filter to built-in rows", () => {
    const { result } = render({ categoryFilter: "flagship" })
    expect(result.current.rows.map((r) => r.id)).toEqual(["openai"])
  })

  it("includes custom providers and marks them as such", () => {
    const { result } = render({
      settings: makeSettings({
        visibleCustomProviderIds: ["my-gateway"],
        customProviders: {
          "my-gateway": {
            customName: "My Gateway",
            baseURL: "https://gw.example",
            customModels: [{ id: "a" }, { id: "b" }],
          },
        } as never,
      }),
    })
    expect(result.current.rows.map((r) => r.id)).toEqual(["openai", "anthropic", "my-gateway"])
    expect(result.current.rows[2]).toMatchObject({
      name: "My Gateway",
      subtitle: "https://gw.example",
      isCustom: true,
      modelCount: 2,
    })
  })

  // "custom" is the one filter that hides every built-in row rather than
  // narrowing them.
  it("shows only custom rows under the custom filter", () => {
    const { result } = render({
      categoryFilter: "custom",
      settings: makeSettings({
        visibleCustomProviderIds: ["my-gateway"],
        customProviders: { "my-gateway": { customName: "My Gateway" } } as never,
      }),
    })
    expect(result.current.rows.map((r) => r.id)).toEqual(["my-gateway"])
  })

  it("drops a custom id with no matching row instead of rendering a blank", () => {
    const { result } = render({
      settings: makeSettings({ visibleCustomProviderIds: ["deleted"], customProviders: {} }),
    })
    expect(result.current.rows.map((r) => r.id)).toEqual(["openai", "anthropic"])
  })

  // Sorting by name keeps the two groups apart so custom endpoints stay below
  // the catalog. Every other sort interleaves them.
  it("keeps custom rows last for the name sort but interleaves for others", () => {
    const settings = makeSettings({
      visibleCustomProviderIds: ["zed-gateway"],
      customProviders: { "zed-gateway": { customName: "Zed" } } as never,
    })
    expect(render({ settings, sortBy: "name" }).result.current.rows.map((r) => r.id)).toEqual([
      "openai",
      "anthropic",
      "zed-gateway",
    ])
    expect(render({ settings, sortBy: "status" }).result.current.rows.map((r) => r.id)).toEqual([
      "zed-gateway",
      "openai",
      "anthropic",
    ])
  })

  it("decorates rows with the diagnostic badge and last-used time", () => {
    const now = Date.now()
    liveQueryQueue = [
      new Map([["openai", { status: "completed", startedAt: now }]]),
      new Map(),
      { openai: 1_700_000_000_000 },
    ]
    const { result } = render({ sortBy: "lastUsed" })
    const openai = result.current.rows.find((r) => r.id === "openai")
    expect(openai).toMatchObject({ diagnosticStatus: "passed", lastUsedAt: 1_700_000_000_000 })
  })

  it("projects the per-model samples into the models-tab badge map", () => {
    const now = Date.now()
    liveQueryQueue = [
      new Map(),
      new Map([
        ["gpt-4.1", { status: "completed", startedAt: now }],
        ["o3", { status: "failed", startedAt: now }],
      ]),
      undefined,
    ]
    const { result } = render()
    expect(result.current.modelDiagnosticBadges).toEqual({ "gpt-4.1": "passed", o3: "failed" })
  })

  it("renders rows before any live query has resolved", () => {
    liveQueryQueue = [undefined, undefined, undefined]
    const { result } = render()
    expect(result.current.rows).toHaveLength(2)
    expect(result.current.rows[0].diagnosticStatus).toBeUndefined()
    expect(result.current.modelDiagnosticBadges).toEqual({})
  })
})

it("uses the effective subscription projection for provider readiness", () => {
  const projected = {
    providerId: "openai",
    enabled: true,
    defaultModel: "",
    apiKey: "subscription:hash",
  }
  render({ settings: makeSettings({ readinessProviderSettings: { openai: projected } }) })
  expect(jest.requireMock("./provider-readiness").getBuiltInProviderReadiness).toHaveBeenCalledWith(
    "openai",
    projected,
    null
  )
})

it("searches dynamic provider metadata without requiring a static catalog row", () => {
  const settings = makeSettings({
    filteredProviders: [
      [
        "plugin-vendor",
        { id: "plugin-vendor", name: "New Plugin Vendor", models: [], defaultModel: "model" },
      ],
    ] as never,
  })
  const { result } = render({ settings, search: "new plugin" })
  expect(result.current.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "plugin-vendor", name: "New Plugin Vendor" }),
    ])
  )
})
