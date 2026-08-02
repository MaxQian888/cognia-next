/** @jest-environment jsdom */
import {
  createDefaultRecoveryProbeDeps,
  createDefaultRecoveryProbes,
  preloadRecoveryProbeRegistries,
  resetRecoveryProbeRegistries,
} from "./default-probes"

const pluginsTable = { count: jest.fn(), toArray: jest.fn() }

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ plugins: pluginsTable }),
}))
jest.mock("@/lib/claude/ipc", () => ({ getSidecarStatus: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({ listAdapterInstances: jest.fn() }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn() }))
jest.mock("@/lib/native/external-agent", () => ({ listExternalAgents: jest.fn() }))
jest.mock("@/lib/plugin/core/validation", () => ({ validatePluginManifest: jest.fn() }))
jest.mock("@/lib/connectors/adapter-metadata", () => ({ listConnectorMetadata: jest.fn() }))

const { getSidecarStatus } = jest.requireMock("@/lib/claude/ipc")
const { listAdapterInstances } = jest.requireMock("@/lib/db/adapter-instances")
const { listWorkflows } = jest.requireMock("@/lib/db/workflows")
const { listExternalAgents } = jest.requireMock("@/lib/native/external-agent")
const { validatePluginManifest } = jest.requireMock("@/lib/plugin/core/validation")
const { listConnectorMetadata } = jest.requireMock("@/lib/connectors/adapter-metadata")

describe("default recovery probe wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetRecoveryProbeRegistries()
    pluginsTable.count.mockResolvedValue(2)
    pluginsTable.toArray.mockResolvedValue([{ id: "web-tools", manifest: { id: "web-tools" } }])
    getSidecarStatus.mockResolvedValue({ ready: true })
    listAdapterInstances.mockResolvedValue([{ type: "lark" }, { type: "lark" }])
    listWorkflows.mockResolvedValue([{ id: "workflow-1" }])
    listExternalAgents.mockResolvedValue(["claude-code"])
    validatePluginManifest.mockReturnValue({ valid: true })
    listConnectorMetadata.mockReturnValue([{ type: "lark" }, { type: "slack" }])
  })

  it("reads the database through a count, not a write", async () => {
    const deps = createDefaultRecoveryProbeDeps()
    await expect(deps.countPluginRows()).resolves.toBe(2)
    expect(pluginsTable.count).toHaveBeenCalled()
  })

  it("reads plugin manifests without activating any plugin", async () => {
    const deps = createDefaultRecoveryProbeDeps()
    await expect(deps.listPluginManifests()).resolves.toEqual([
      { id: "web-tools", manifest: { id: "web-tools" } },
    ])
  })

  it("queries sidecar status rather than starting it", async () => {
    const deps = createDefaultRecoveryProbeDeps()
    await expect(deps.getSidecarStatus()).resolves.toEqual({ ready: true })
    expect(getSidecarStatus).toHaveBeenCalledTimes(1)
  })

  it("deduplicates the platform kinds configured adapters reference", async () => {
    const deps = createDefaultRecoveryProbeDeps()
    await expect(deps.listReferencedConnectorAdapterIds()).resolves.toEqual(["lark"])
  })

  it("maps workflow and external-agent rows to ids", async () => {
    const deps = createDefaultRecoveryProbeDeps()
    await expect(deps.listWorkflowIds()).resolves.toEqual(["workflow-1"])
    await expect(deps.listExternalAgentIds()).resolves.toEqual(["claude-code"])
  })

  describe("registry preload", () => {
    it("keys connector metadata by platform kind", async () => {
      await preloadRecoveryProbeRegistries()
      const deps = createDefaultRecoveryProbeDeps()
      expect(deps.listConnectorAdapterIds()).toEqual(["lark", "slack"])
    })

    it("uses the real validator once preloaded", async () => {
      validatePluginManifest.mockReturnValue({ valid: false })
      await preloadRecoveryProbeRegistries()
      const deps = createDefaultRecoveryProbeDeps()
      expect(deps.validateManifest({})).toEqual({ valid: false })
    })

    it("stays permissive when the validator cannot be loaded", () => {
      // Not preloaded: a probe must not condemn plugins because its own
      // reference data is missing.
      const deps = createDefaultRecoveryProbeDeps()
      expect(deps.validateManifest({ anything: true })).toEqual({ valid: true })
      expect(deps.listConnectorAdapterIds()).toEqual([])
    })
  })

  it("builds a probe set that passes on a healthy host", async () => {
    const probes = await createDefaultRecoveryProbes()
    await expect(probes.database()).resolves.toEqual({ ok: true })
    await expect(probes.plugins()).resolves.toEqual({ ok: true })
    await expect(probes.sidecar()).resolves.toEqual({ ok: true })
    await expect(probes.connectors()).resolves.toEqual({ ok: true })
    await expect(probes.workflow()).resolves.toEqual({ ok: true })
    await expect(probes["external-agent"]()).resolves.toEqual({ ok: true })
  })

  it("catches an adapter whose platform this build no longer ships", async () => {
    listAdapterInstances.mockResolvedValue([{ type: "removed-platform" }])
    const probes = await createDefaultRecoveryProbes()
    await expect(probes.connectors()).resolves.toEqual({
      ok: false,
      reasonCode: "connectors.adapter_missing",
    })
  })
})
