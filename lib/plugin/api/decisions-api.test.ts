jest.mock("@/lib/decisions/host-registry", () => ({ getDecisionRegistry: jest.fn() }))
jest.mock("@/lib/decisions/config", () => ({ loadDecisionSettings: jest.fn() }))
jest.mock("@/lib/decisions/run-decision", () => ({ runDecision: jest.fn() }))

import { createDecisionRegistry } from "@/lib/decisions/registry"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import type { DecisionProviderResponse, DecisionResult } from "@/types/decisions"
import type { PluginDecisionProviderInput } from "@/types/plugin/plugin-decisions"
import {
  clearDecisionProvidersForPlugin,
  createDecisionsAPI,
  registerPluginDecisionProvider,
  type PluginDecisionsRuntime,
} from "./decisions-api"

function input(id: string): PluginDecisionProviderInput {
  return {
    id,
    label: `Provider ${id}`,
    locality: "local",
    calibrated: true,
    decide: async (): Promise<DecisionProviderResponse> => ({ ok: true, answers: {} }),
  }
}

function runtime(overrides: Partial<PluginDecisionsRuntime> = {}) {
  const registry = createDecisionRegistry()
  const run = jest.fn(async (): Promise<DecisionResult> => ({
    ok: true,
    providerId: "x",
    answers: {},
    latencyMs: 1,
  }))
  const rt: PluginDecisionsRuntime = {
    registry: () => registry,
    run,
    selectedProviderId: async () => "laya:laya-local",
    ...overrides,
  }
  return { registry, run, rt }
}

beforeEach(() => {
  resetPermissionGuard()
  const guard = getPermissionGuard({ confirmDangerousByDefault: false })
  guard.registerPlugin("consumer", ["decisions:run"])
  guard.registerPlugin("laya", ["decisions:provide"])
  guard.registerPlugin("bare", [])
})

describe("createDecisionsAPI", () => {
  it("routes decide through runDecision with the caller stamped", async () => {
    const { rt, run } = runtime()
    const api = createDecisionsAPI("consumer", rt)
    const controller = new AbortController()
    const request = { state: "hi", questions: { q: { type: "noul" as const, instructions: "?" } } }
    await api.decide(request, { providerId: "laya:laya-local", signal: controller.signal })
    expect(run).toHaveBeenCalledWith(request, {
      providerId: "laya:laya-local",
      signal: controller.signal,
      callerPluginId: "consumer",
    })
  })

  it("requires decisions:run for decide", () => {
    const { rt, run } = runtime()
    const api = createDecisionsAPI("bare", rt)
    // The guard refuses synchronously, before the async body runs.
    expect(() =>
      api.decide({ state: "hi", questions: { q: { type: "noul", instructions: "?" } } })
    ).toThrow(/decisions:run/)
    expect(run).not.toHaveBeenCalled()
  })

  it("registers providers under the plugin prefix and lists them", () => {
    const { rt, registry } = runtime()
    const api = createDecisionsAPI("laya", rt)
    const handle = api.registerProvider(input("laya-local"))
    expect(handle.providerId).toBe("laya:laya-local")
    expect(registry.get("laya:laya-local")?.pluginId).toBe("laya")
    expect(api.listRegistered()).toEqual(["laya:laya-local"])
    expect(api.listProviders()).toEqual([
      {
        id: "laya:laya-local",
        label: "Provider laya-local",
        pluginId: "laya",
        locality: "local",
        calibrated: true,
      },
    ])
    handle.unregister()
    handle.unregister()
    expect(api.listRegistered()).toEqual([])
  })

  it("requires decisions:provide to register", () => {
    const { rt } = runtime()
    expect(() => createDecisionsAPI("bare", rt).registerProvider(input("x"))).toThrow(
      /decisions:provide/
    )
  })

  it("reports the selected provider without a permission", async () => {
    const { rt } = runtime({ selectedProviderId: async () => null })
    await expect(createDecisionsAPI("bare", rt).getSelectedProviderId()).resolves.toBeNull()
  })
})

describe("registerPluginDecisionProvider", () => {
  it.each([
    [{ ...input("x"), id: "" }, /without an id/],
    [{ ...input("x"), decide: undefined }, /decide/],
    [{ ...input("x"), label: "" }, /label/],
    [{ ...input("x"), locality: "cloud" }, /locality/],
  ])("rejects malformed providers %#", (provider, error) => {
    const registry = createDecisionRegistry()
    expect(() =>
      registerPluginDecisionProvider(
        "p",
        provider as unknown as PluginDecisionProviderInput,
        registry
      )
    ).toThrow(error)
  })

  it("coerces a missing calibration claim to false", () => {
    const registry = createDecisionRegistry()
    const { calibrated: _omit, ...rest } = input("x")
    registerPluginDecisionProvider("p", rest as PluginDecisionProviderInput, registry)
    expect(registry.get("p:x")?.calibrated).toBe(false)
  })

  it("is cleared per plugin on disable", () => {
    const registry = createDecisionRegistry()
    registerPluginDecisionProvider("p", input("a"), registry)
    registerPluginDecisionProvider("q", input("a"), registry)
    clearDecisionProvidersForPlugin("p", registry)
    expect(registry.list().map((p) => p.id)).toEqual(["q:a"])
  })
})
