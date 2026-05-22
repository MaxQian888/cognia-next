/**
 * Pure tests for the v1 → v2 migration helper.
 *
 * Exercises:
 *   - Empty / non-object input is passed through.
 *   - v2 input is passed through unchanged (idempotency).
 *   - v1 default config is backfilled with governancePolicy + capabilities.
 *   - v1 per-template config is backfilled the same way.
 *   - Templates without a `config` block are left alone.
 */

import "fake-indexeddb/auto"
import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"
import { migrateAgentTeamPersisted } from "./store"

describe("migrateAgentTeamPersisted", () => {
  it("returns non-object input as-is", () => {
    expect(migrateAgentTeamPersisted(null, 1)).toBeNull()
    expect(migrateAgentTeamPersisted(undefined, 1)).toBeUndefined()
    expect(migrateAgentTeamPersisted(42 as unknown, 1)).toBe(42)
  })

  it("returns v2+ input unchanged", () => {
    const v2 = { defaultConfig: { capabilities: { skillIds: ["s"] } } }
    const out = migrateAgentTeamPersisted(v2, 2)
    expect(out).toBe(v2)
  })

  it("backfills governancePolicy + capabilities on a v1 default config", () => {
    const v1 = { defaultConfig: { maxTeammates: 10 } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.defaultConfig.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
    expect("capabilities" in out.defaultConfig).toBe(true)
    expect(out.defaultConfig.capabilities).toBeUndefined()
  })

  it("preserves an existing governancePolicy on a v1 default config", () => {
    const customPolicy = {
      approval: { requirePlanApproval: true, requireDelegationApproval: false },
      budget: {
        tokenBudget: 42,
        warningThreshold: 0.5,
        criticalThreshold: 0.9,
        onCritical: "pause_for_review",
      },
      escalation: { allowOperatorPatternOverride: false, pauseOnHighRisk: true },
    }
    const v1 = { defaultConfig: { governancePolicy: customPolicy } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.defaultConfig.governancePolicy).toBe(customPolicy)
  })

  it("backfills per-template configs", () => {
    const v1 = {
      templates: {
        a: { config: { maxTeammates: 5 } },
        b: { config: {} },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.templates.a.config.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
    expect("capabilities" in out.templates.a.config).toBe(true)
    expect(out.templates.b.config.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
  })

  it("leaves templates without a `config` block untouched", () => {
    const v1 = { templates: { a: { name: "x" } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, 1) as any
    expect(out.templates.a).toEqual({ name: "x" })
  })

  it("treats missing version as v1 (forward-compatible default)", () => {
    const v1 = { defaultConfig: {} }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = migrateAgentTeamPersisted(v1, undefined) as any
    expect(out.defaultConfig.governancePolicy).toEqual(DEFAULT_TEAM_CONFIG.governancePolicy)
  })
})
