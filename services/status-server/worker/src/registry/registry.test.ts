import { beforeEach, describe, expect, it } from "vitest"

import { PROFILE_FRESH_MS, REFERENCE_FRESH_MS } from "../../../../../lib/status/contract"
import { EXT_KEY_ID, OTHER_KEY_ID, resetCore, seedRegistry, testEnv } from "../../test/helpers"
import {
  cadenceDue,
  freshnessForCadence,
  loadRegistry,
  observationStartMinute,
  probeActive,
  referenceForMinute,
  resolveProbeKey,
} from "./registry"

const db = () => testEnv.DB

describe("seed migration", () => {
  it("registers the Cron observer as the initial reference without any health rows", async () => {
    // Runs first in this file, before any suite resets the registry.
    const registry = await loadRegistry(db())
    const cron = registry.probes.get("cf-cron")!
    expect(cron.source).toBe("cloudflare")
    expect(cron.profiles.map((profile) => profile.id)).toEqual(["native", "web", "ios", "android"])
    expect(registry.epochs[0]).toMatchObject({ revision: 1, probeId: "cf-cron" })
    const health = await db()
      .prepare("SELECT COUNT(*) AS n FROM reference_slots")
      .first<{ n: number }>()
    expect(health?.n).toBe(0)
  })
})

describe("registry reads", () => {
  beforeEach(async () => {
    await resetCore()
    await seedRegistry(
      [
        { id: "a", enrolledAtMs: 600_000, keyId: EXT_KEY_ID },
        { id: "b", enrolledAtMs: 600_000, keyId: OTHER_KEY_ID, disabled: true },
      ],
      [
        { probeId: "a", effectiveMinute: 10 },
        { probeId: "b", effectiveMinute: 100 },
      ]
    )
  })

  it("selects the reference epoch in force for each minute", async () => {
    const registry = await loadRegistry(db())
    expect(referenceForMinute(registry, 9)).toBeNull()
    expect(referenceForMinute(registry, 10)?.probeId).toBe("a")
    expect(referenceForMinute(registry, 99)?.probeId).toBe("a")
    expect(referenceForMinute(registry, 100)?.probeId).toBe("b")
    expect(observationStartMinute(registry)).toBe(10)
  })

  it("treats disabled, pre-enrollment and retired probes as inactive", async () => {
    const registry = await loadRegistry(db())
    expect(probeActive(registry.probes.get("a")!, 600_000)).toBe(true)
    expect(probeActive(registry.probes.get("a")!, 599_999)).toBe(false)
    expect(probeActive(registry.probes.get("b")!, 700_000)).toBe(false)
    expect(probeActive({ ...registry.probes.get("a")!, retiredAtMs: 650_000 }, 650_000)).toBe(false)
  })

  it("resolves a key only inside its validity window and with a configured secret", async () => {
    const now = Date.now()
    expect(await resolveProbeKey(testEnv, EXT_KEY_ID, now)).toMatchObject({ probeId: "a" })
    await db()
      .prepare("UPDATE probe_keys SET not_after = ? WHERE key_id = ?")
      .bind(now - 1, EXT_KEY_ID)
      .run()
    expect(await resolveProbeKey(testEnv, EXT_KEY_ID, now)).toBeNull()
    await db()
      .prepare("UPDATE probe_keys SET not_after = NULL, revoked_at = ? WHERE key_id = ?")
      .bind(now - 1, EXT_KEY_ID)
      .run()
    expect(await resolveProbeKey(testEnv, EXT_KEY_ID, now)).toBeNull()
    // Registered row but no secret configured.
    await db()
      .prepare("INSERT INTO probe_keys (key_id, probe_id, not_before) VALUES ('no-secret', 'a', 0)")
      .run()
    expect(await resolveProbeKey(testEnv, "no-secret", now)).toBeNull()
  })

  it("schedules cadences on minute multiples and sizes freshness by cadence", () => {
    expect(cadenceDue(60, 7)).toBe(true)
    expect(cadenceDue(300, 10)).toBe(true)
    expect(cadenceDue(300, 11)).toBe(false)
    expect(cadenceDue(null, 10)).toBe(false)
    expect(freshnessForCadence(60)).toBe(REFERENCE_FRESH_MS)
    expect(freshnessForCadence(300)).toBe(PROFILE_FRESH_MS)
    expect(freshnessForCadence(600)).toBe(1_800_000)
  })
})
