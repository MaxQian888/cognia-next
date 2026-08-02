import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import {
  RECOVERY_ORDER,
  allEnabledCheckpointsPassed,
  automaticReloadsDisabled,
  checkpointFor,
  isRecoverySubsystem,
  nextCheckpoint,
  recentRecoveryAudit,
  recoveryProgress,
  recoverySuspect,
  requiresSafeShell,
  type RecoveryStateV1,
} from "./recovery-state"

const FIXTURE_DIR = join(__dirname, "schemas", "recovery-fixtures")

interface RecoveryScenario {
  name: string
  buildId: string
  steps: unknown[]
  expected: RecoveryStateV1
}

function scenarios(): { file: string; scenario: RecoveryScenario }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      scenario: JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as RecoveryScenario,
    }))
}

function byName(file: string): RecoveryStateV1 {
  const match = scenarios().find((entry) => entry.file === file)
  if (!match) throw new Error(`missing recovery fixture: ${file}`)
  return match.scenario.expected
}

/**
 * These fixtures are produced by replaying scenarios through the Rust state
 * machine (`cognia_observability::recovery`). Reading them here proves the
 * renderer's selectors agree with the runtime that actually owns the
 * transitions — the guarantee the old renderer-side policy could not give,
 * because nothing ever compared the two.
 */
describe("recovery state selectors", () => {
  it("has golden scenarios on disk, each carrying a replayed expected state", () => {
    const all = scenarios()
    expect(all.length).toBeGreaterThan(0)
    for (const { file, scenario } of all) {
      expect({ file, hasExpected: Boolean(scenario.expected) }).toEqual({
        file,
        hasExpected: true,
      })
      expect(scenario.expected.schemaVersion).toBe(1)
    }
  })

  it("keeps the subsystem order in lockstep with the runtime", () => {
    for (const { scenario } of scenarios()) {
      const order = scenario.expected.checkpoints.map((checkpoint) => checkpoint.subsystem)
      if (order.length > 0) {
        expect(order).toEqual([...RECOVERY_ORDER])
      }
    }
  })

  it("recognizes exactly the six documented subsystems", () => {
    for (const subsystem of RECOVERY_ORDER) {
      expect(isRecoverySubsystem(subsystem)).toBe(true)
    }
    expect(isRecoverySubsystem("renderer")).toBe(false)
    expect(isRecoverySubsystem("Database")).toBe(false)
    expect(isRecoverySubsystem(undefined)).toBe(false)
  })

  describe("a boot loop", () => {
    const state = byName("boot-loop-enters-safe-mode.json")

    it("requires the diagnostics shell", () => {
      expect(state.mode).toBe("safe")
      expect(requiresSafeShell(state)).toBe(true)
    })

    it("starts the checkpoint sequence at the database group", () => {
      expect(nextCheckpoint(state)).toBe("database")
      expect(allEnabledCheckpointsPassed(state)).toBe(false)
    })

    it("names no suspect yet — nothing has been probed", () => {
      expect(recoverySuspect(state)).toBeUndefined()
    })

    it("reports every group pending", () => {
      expect(recoveryProgress(state)).toEqual({
        total: 6,
        passed: 0,
        failed: 0,
        skipped: 0,
        pending: 6,
        disabled: 0,
      })
    })
  })

  describe("a contained checkpoint failure", () => {
    const state = byName("checkpoint-failure-contains-later-groups.json")

    it("keeps the group that already passed available", () => {
      expect(checkpointFor(state, "database")?.status).toBe("passed")
    })

    it("marks the failing group and skips everything after it", () => {
      expect(checkpointFor(state, "plugins")?.status).toBe("failed")
      for (const later of ["sidecar", "connectors", "workflow", "external-agent"] as const) {
        expect(checkpointFor(state, later)).toMatchObject({
          status: "skipped",
          reasonCode: "blocked_by.plugins",
        })
      }
    })

    it("names the suspect and its reason code", () => {
      expect(recoverySuspect(state)).toEqual({
        subsystem: "plugins",
        reasonCode: "plugins.probe_failed",
      })
    })

    it("stops the sequence rather than advancing past the blocker", () => {
      expect(nextCheckpoint(state)).toBeUndefined()
    })

    it("counts the contained groups", () => {
      expect(recoveryProgress(state)).toEqual({
        total: 6,
        passed: 1,
        failed: 1,
        skipped: 4,
        pending: 0,
        disabled: 0,
      })
    })
  })

  describe("a healthy reset", () => {
    const state = byName("healthy-reset-clears-budgets.json")

    it("returns to normal and clears every budget", () => {
      expect(state.mode).toBe("normal")
      expect(requiresSafeShell(state)).toBe(false)
      expect(state.unhealthyStarts).toEqual([])
      expect(state.childRestarts).toEqual({})
      expect(automaticReloadsDisabled(state)).toBe(false)
    })

    it("passes every checkpoint", () => {
      expect(allEnabledCheckpointsPassed(state)).toBe(true)
      expect(nextCheckpoint(state)).toBeUndefined()
      expect(recoveryProgress(state).passed).toBe(6)
    })

    it("keeps the audit history that the budget reset did not erase", () => {
      const codes = state.audit.map((entry) => entry.code)
      expect(codes).toContain("recovery.start.unhealthy")
      expect(codes).toContain("recovery.renderer.reload")
      expect(codes).toContain("recovery.child.restart")
      expect(codes).toContain("recovery.stable")
    })

    it("returns the audit newest-first for the timeline", () => {
      const recent = recentRecoveryAudit(state, 2)
      expect(recent).toHaveLength(2)
      expect(recent[0].code).toBe("recovery.stable")
      expect(recent[0].at).toBeGreaterThanOrEqual(recent[1].at)
    })

    it("clamps a negative audit limit to nothing", () => {
      expect(recentRecoveryAudit(state, -5)).toEqual([])
    })
  })

  it("treats a subsystem the operator kept disabled as not blocking health", () => {
    const base = byName("checkpoint-failure-contains-later-groups.json")
    const state: RecoveryStateV1 = {
      ...base,
      disabledSubsystems: ["plugins"],
      checkpoints: base.checkpoints.map((checkpoint) =>
        checkpoint.subsystem === "plugins"
          ? { ...checkpoint, status: "skipped" as const }
          : { ...checkpoint, status: "passed" as const }
      ),
    }
    expect(allEnabledCheckpointsPassed(state)).toBe(true)
    expect(recoveryProgress(state).disabled).toBe(1)
  })

  it("returns undefined for a subsystem that is not in the state", () => {
    const state = byName("boot-loop-enters-safe-mode.json")
    expect(checkpointFor({ checkpoints: [] }, "database")).toBeUndefined()
    expect(checkpointFor(state, "workflow")).toBeDefined()
  })

  it("reports a suspect carrying only a reason code", () => {
    expect(recoverySuspect({ suspectReasonCode: "renderer.reload_budget_exhausted" })).toEqual({
      subsystem: undefined,
      reasonCode: "renderer.reload_budget_exhausted",
    })
  })
})
