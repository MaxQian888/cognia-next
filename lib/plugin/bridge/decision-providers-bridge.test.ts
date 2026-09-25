import { createDecisionRegistry, type DecisionRegistry } from "@/lib/decisions/registry"

let registry: DecisionRegistry
jest.mock("@/lib/decisions/host-registry", () => ({ getDecisionRegistry: () => registry }))
jest.mock("@/lib/decisions/config", () => ({ loadDecisionSettings: jest.fn() }))
jest.mock("@/lib/decisions/run-decision", () => ({ runDecision: jest.fn() }))

import type { PluginManifest } from "@/types/plugin/plugin"
import {
  registerDecisionProvidersForPlugin,
  unregisterDecisionProvidersForPlugin,
} from "./decision-providers-bridge"

function manifest(overrides: Partial<PluginManifest>): PluginManifest {
  return { id: "laya", name: "Laya", version: "0.1.0", ...overrides } as PluginManifest
}

beforeEach(() => {
  registry = createDecisionRegistry()
})

describe("registerDecisionProvidersForPlugin — python", () => {
  it("registers the described provider and forwards only the request", async () => {
    const decide = jest.fn(async () => ({ ok: true, answers: { q: { noul: 1 } } }))
    const status = jest.fn(async () => ({ ready: true }))
    const describePython = jest.fn(async () => ({
      locality: "local",
      calibrated: true,
      limits: { headTokens: 192, inputTokens: 512, optionTokens: 48, junk: -1 },
      validatedQuestionSets: ["jev-judge/v1", "", 3],
      decide,
      status,
    }))
    const result = await registerDecisionProvidersForPlugin(
      manifest({
        type: "python",
        decisionProviders: [{ id: "laya-local", label: "Laya (local)", labelKey: "laya.label" }],
      }),
      "/plugins/laya",
      { hasPermission: () => true, describePython: describePython as never }
    )
    expect(result).toEqual({ registered: 1, errors: [] })
    expect(describePython).toHaveBeenCalledWith({
      pluginId: "laya",
      contributionId: "laya-local",
      methods: ["decide", "status"],
      label: "Decision provider",
    })
    const provider = registry.get("laya:laya-local")!
    expect(provider).toMatchObject({
      label: "Laya (local)",
      labelKey: "laya.label",
      pluginId: "laya",
      locality: "local",
      calibrated: true,
      limits: { headTokens: 192, inputTokens: 512, optionTokens: 48 },
      validatedQuestionSets: ["jev-judge/v1"],
    })
    const request = { state: "hi", questions: { q: { type: "noul" as const, instructions: "?" } } }
    await provider.decide(request, { signal: new AbortController().signal })
    expect(decide).toHaveBeenCalledWith(request)
    await provider.status?.()
    expect(status).toHaveBeenCalledWith()
  })

  it("refuses a described object without decide()", async () => {
    const result = await registerDecisionProvidersForPlugin(
      manifest({ type: "python", decisionProviders: [{ id: "x", label: "X" }] }),
      "/p",
      { hasPermission: () => true, describePython: (async () => ({ locality: "local" })) as never }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(/decide/)
  })

  it("defaults unknown locality claims to local and missing calibration to false", async () => {
    await registerDecisionProvidersForPlugin(
      manifest({ type: "python", decisionProviders: [{ id: "x", label: "X" }] }),
      "/p",
      {
        hasPermission: () => true,
        describePython: (async () => ({
          locality: "cloud",
          decide: async () => ({ ok: true, answers: {} }),
        })) as never,
      }
    )
    expect(registry.get("laya:x")).toMatchObject({ locality: "local", calibrated: false })
  })
})

describe("registerDecisionProvidersForPlugin — js", () => {
  it("imports the factory and lets the manifest own the label", async () => {
    const factory = jest.fn(() => ({
      id: "ignored",
      label: "code label",
      locality: "remote",
      calibrated: false,
      decide: async () => ({ ok: true, answers: {} }),
    }))
    const importer = jest.fn(async () => ({ makeProvider: factory }))
    const result = await registerDecisionProvidersForPlugin(
      manifest({
        decisionProviders: [
          { id: "cloud", label: "Cloud judge", entry: "dist/p.js", export: "makeProvider" },
        ],
      }),
      "/plugins/laya",
      { hasPermission: () => true, importer }
    )
    expect(result.registered).toBe(1)
    expect(importer).toHaveBeenCalledWith("/plugins/laya/dist/p.js")
    expect(factory).toHaveBeenCalledWith({ providerId: "laya:cloud", pluginId: "laya" })
    expect(registry.get("laya:cloud")).toMatchObject({ label: "Cloud judge", locality: "remote" })
  })

  it.each([
    [{ id: "a", label: "A" }, /entry.*export/],
    [{ id: "a", label: "A", entry: "p.js", export: "__proto__" }, /invalid export/],
    [{ id: "a", label: "A", entry: "p.js", export: "missing" }, /does not export/],
    [{ id: "", label: "A" }, /needs an id/],
    [{ id: "a", label: "" }, /needs a label/],
  ])("collects errors for %j", async (def, error) => {
    const result = await registerDecisionProvidersForPlugin(
      manifest({ decisionProviders: [def] }),
      "/p",
      { hasPermission: () => true, importer: async () => ({}) }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(error)
  })
})

describe("permissions and lifecycle", () => {
  it("registers nothing without decisions:provide", async () => {
    const describePython = jest.fn()
    const result = await registerDecisionProvidersForPlugin(
      manifest({ type: "python", decisionProviders: [{ id: "x", label: "X" }] }),
      "/p",
      { hasPermission: () => false, describePython: describePython as never }
    )
    expect(result.errors[0].message).toMatch(/decisions:provide/)
    expect(describePython).not.toHaveBeenCalled()
  })

  it("is a no-op for manifests without providers, and unregisters on disable", async () => {
    await expect(
      registerDecisionProvidersForPlugin(manifest({}), "/p", { hasPermission: () => true })
    ).resolves.toEqual({ registered: 0, errors: [] })
    await registerDecisionProvidersForPlugin(
      manifest({ type: "python", decisionProviders: [{ id: "x", label: "X" }] }),
      "/p",
      {
        hasPermission: () => true,
        describePython: (async () => ({
          decide: async () => ({ ok: true, answers: {} }),
        })) as never,
      }
    )
    // Re-enable clears first instead of tripping the duplicate guard.
    const again = await registerDecisionProvidersForPlugin(
      manifest({ type: "python", decisionProviders: [{ id: "x", label: "X" }] }),
      "/p",
      {
        hasPermission: () => true,
        describePython: (async () => ({
          decide: async () => ({ ok: true, answers: {} }),
        })) as never,
      }
    )
    expect(again.registered).toBe(1)
    unregisterDecisionProvidersForPlugin("laya")
    expect(registry.list()).toEqual([])
  })
})
