import { RECOVERY_ORDER, type RecoverySubsystem } from "@cognia/logging"

import {
  PROBE_FALLBACK_REASON,
  createRecoveryProbes,
  runProbe,
  runRecoverySequence,
  type RecoveryProbeDeps,
  type RecoveryProbeSet,
} from "./probes"

function healthyDeps(overrides: Partial<RecoveryProbeDeps> = {}): RecoveryProbeDeps {
  return {
    countPluginRows: async () => 3,
    listPluginManifests: async () => [{ id: "web-tools", manifest: { id: "web-tools" } }],
    validateManifest: () => ({ valid: true }),
    getSidecarStatus: async () => ({ ready: true }),
    listConnectorAdapterIds: () => ["lark", "slack"],
    listReferencedConnectorAdapterIds: async () => ["lark"],
    listWorkflowIds: async () => ["workflow-1"],
    listExternalAgentIds: async () => ["claude-code"],
    ...overrides,
  }
}

async function results(probes: RecoveryProbeSet) {
  const entries = await Promise.all(
    RECOVERY_ORDER.map(async (subsystem) => [subsystem, await probes[subsystem]()] as const)
  )
  return Object.fromEntries(entries) as Record<
    RecoverySubsystem,
    { ok: boolean; reasonCode?: string }
  >
}

describe("recovery probes", () => {
  it("covers every subsystem in the recovery order", () => {
    const probes = createRecoveryProbes(healthyDeps())
    expect(Object.keys(probes).sort()).toEqual([...RECOVERY_ORDER].sort())
  })

  it("passes every group on a healthy host", async () => {
    const all = await results(createRecoveryProbes(healthyDeps()))
    for (const subsystem of RECOVERY_ORDER) {
      expect({ subsystem, ...all[subsystem] }).toEqual({ subsystem, ok: true })
    }
  })

  describe("database", () => {
    it("fails when the row count is not a real count", async () => {
      const probes = createRecoveryProbes(healthyDeps({ countPluginRows: async () => NaN }))
      await expect(probes.database()).resolves.toEqual({
        ok: false,
        reasonCode: "database.unreadable",
      })
    })

    it("accepts an empty but readable database", async () => {
      const probes = createRecoveryProbes(healthyDeps({ countPluginRows: async () => 0 }))
      await expect(probes.database()).resolves.toEqual({ ok: true })
    })
  })

  describe("plugins", () => {
    it("fails on an invalid manifest and names the reason", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ validateManifest: () => ({ valid: false }) })
      )
      await expect(probes.plugins()).resolves.toEqual({
        ok: false,
        reasonCode: "plugins.manifest_invalid",
      })
    })

    it("passes when no plugins are installed", async () => {
      const probes = createRecoveryProbes(healthyDeps({ listPluginManifests: async () => [] }))
      await expect(probes.plugins()).resolves.toEqual({ ok: true })
    })
  })

  describe("sidecar", () => {
    it("fails when the sidecar reports not ready", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ getSidecarStatus: async () => ({ ready: false }) })
      )
      await expect(probes.sidecar()).resolves.toEqual({
        ok: false,
        reasonCode: "sidecar.not_ready",
      })
    })
  })

  describe("connectors", () => {
    it("fails when persisted state references an adapter this build does not have", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ listReferencedConnectorAdapterIds: async () => ["lark", "removed-adapter"] })
      )
      await expect(probes.connectors()).resolves.toEqual({
        ok: false,
        reasonCode: "connectors.adapter_missing",
      })
    })

    it("passes when nothing is configured", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ listReferencedConnectorAdapterIds: async () => [] })
      )
      await expect(probes.connectors()).resolves.toEqual({ ok: true })
    })
  })

  describe("workflow and external agents", () => {
    it("fails on an unreadable workflow row", async () => {
      const probes = createRecoveryProbes(healthyDeps({ listWorkflowIds: async () => ["ok", ""] }))
      await expect(probes.workflow()).resolves.toEqual({
        ok: false,
        reasonCode: "workflow.definition_unreadable",
      })
    })

    it("fails on an unreadable external-agent entry", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ listExternalAgentIds: async () => [undefined as unknown as string] })
      )
      await expect(probes["external-agent"]()).resolves.toEqual({
        ok: false,
        reasonCode: "external_agent.registry_unreadable",
      })
    })
  })

  describe("runProbe", () => {
    it("turns a thrown probe into a failure rather than an unhandled rejection", async () => {
      await expect(
        runProbe(async () => {
          throw new Error("/Users/alice/secret/path exploded")
        }, "database.probe_threw")
      ).resolves.toEqual({ ok: false, reasonCode: "database.probe_threw" })
    })

    it("does not leak the thrown value into the persisted result", async () => {
      const result = await runProbe(async () => {
        throw new Error("postgres://user:password@host/db")
      }, "plugins.probe_threw")
      expect(JSON.stringify(result)).not.toContain("password")
    })

    it("passes a healthy probe through unchanged", async () => {
      await expect(runProbe(async () => ({ ok: true }), "x")).resolves.toEqual({ ok: true })
    })
  })

  describe("runRecoverySequence", () => {
    it("runs every group in the documented order when all pass", async () => {
      const seen: RecoverySubsystem[] = []
      const steps = await runRecoverySequence(createRecoveryProbes(healthyDeps()), (subsystem) => {
        seen.push(subsystem)
      })
      expect(seen).toEqual([...RECOVERY_ORDER])
      expect(steps.map((step) => step.subsystem)).toEqual([...RECOVERY_ORDER])
      expect(steps.every((step) => step.result.ok)).toBe(true)
    })

    it("stops at the first failure instead of reporting downstream symptoms", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ validateManifest: () => ({ valid: false }) })
      )
      const steps = await runRecoverySequence(probes, () => {})
      expect(steps.map((step) => step.subsystem)).toEqual(["database", "plugins"])
      expect(steps[1].result).toEqual({ ok: false, reasonCode: "plugins.manifest_invalid" })
    })

    it("awaits each result before running the next probe", async () => {
      const order: string[] = []
      const probes = createRecoveryProbes(healthyDeps())
      await runRecoverySequence(probes, async (subsystem) => {
        order.push(`persist:${subsystem}`)
        await Promise.resolve()
      })
      expect(order).toEqual(RECOVERY_ORDER.map((subsystem) => `persist:${subsystem}`))
    })

    it("skips subsystems the operator kept disabled and continues past them", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({ validateManifest: () => ({ valid: false }) })
      )
      const steps = await runRecoverySequence(probes, () => {}, { skip: ["plugins"] })
      expect(steps.map((step) => step.subsystem)).toEqual([
        "database",
        "sidecar",
        "connectors",
        "workflow",
        "external-agent",
      ])
    })

    it("resumes from a named subsystem after a retry", async () => {
      const steps = await runRecoverySequence(createRecoveryProbes(healthyDeps()), () => {}, {
        startAt: "connectors",
      })
      expect(steps.map((step) => step.subsystem)).toEqual([
        "connectors",
        "workflow",
        "external-agent",
      ])
    })

    it("runs the full order when startAt is not a known subsystem", async () => {
      const steps = await runRecoverySequence(createRecoveryProbes(healthyDeps()), () => {}, {
        startAt: "renderer" as RecoverySubsystem,
      })
      expect(steps).toHaveLength(RECOVERY_ORDER.length)
    })

    it("records a thrown probe as that subsystem's failure", async () => {
      const probes = createRecoveryProbes(
        healthyDeps({
          getSidecarStatus: async () => {
            throw new Error("ipc gone")
          },
        })
      )
      const steps = await runRecoverySequence(probes, () => {})
      expect(steps.at(-1)).toEqual({
        subsystem: "sidecar",
        result: { ok: false, reasonCode: PROBE_FALLBACK_REASON.sidecar },
      })
    })
  })

  it("has a distinct fallback reason code for every subsystem", () => {
    const codes = RECOVERY_ORDER.map((subsystem) => PROBE_FALLBACK_REASON[subsystem])
    expect(new Set(codes).size).toBe(RECOVERY_ORDER.length)
    expect(codes.every((code) => code.endsWith(".probe_threw"))).toBe(true)
  })
})
