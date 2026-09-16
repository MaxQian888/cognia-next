import { FUSION_TABLE_NAMES } from "@/lib/router-fusion/db/fusion-db"

import {
  ROUTER_FUSION_ARTIFACT_CONTENT_DAYS,
  ROUTER_FUSION_EVENT_HISTORY_DAYS,
  ROUTER_FUSION_IDEMPOTENCY_DAYS,
  ROUTER_FUSION_RUN_TRAIL_DAYS,
  ROUTER_FUSION_TABLE_CATALOG,
  routerFusionTablePolicy,
} from "./router-fusion-catalog"
import { CORE_TABLE_NAMES } from "./table-catalog"

describe("Router + Fusion governance catalog", () => {
  it("governs every table of the fusion schema exactly once", () => {
    const names = ROUTER_FUSION_TABLE_CATALOG.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual([...FUSION_TABLE_NAMES].sort())
  })

  it("stays out of the main database's catalog", () => {
    const core = new Set<string>(CORE_TABLE_NAMES)
    for (const entry of ROUTER_FUSION_TABLE_CATALOG) expect(core.has(entry.name)).toBe(false)
  })

  it("declares a complete, honest lifecycle for every table", () => {
    for (const entry of ROUTER_FUSION_TABLE_CATALOG) {
      expect(entry.owner).toBe("router-fusion")
      expect(entry.backupPolicy.mode).toBe("device-local")
      expect(entry.syncPolicy.mode).toBe("none")
      expect(entry.deleteCascade).toMatchObject({
        account: true,
        runtimeTarget: true,
        plugin: false,
      })
      expect(entry.cleanupPolicy).toBe("protected")
      for (const reason of [
        entry.backupPolicy.reason,
        entry.syncPolicy.reason,
        entry.retentionPolicy.reason,
        entry.deleteCascade.reason,
      ]) {
        expect(reason).not.toBe("")
      }
      // No central sweeper knows this database; retention is the domain reaper's.
      expect(entry.retentionPolicy.enforcement).not.toBe("central")
      if (entry.retentionPolicy.mode === "permanent") {
        expect(entry.retentionPolicy.enforcement).toBe("explicit-delete")
      } else {
        expect(entry.retentionPolicy.enforcement).toBe("domain")
        expect(entry.retentionPolicy.days).toBeGreaterThan(0)
      }
    }
  })

  it("never reaps the money ledger", () => {
    expect(routerFusionTablePolicy("fusionLedger")?.retentionPolicy).toMatchObject({
      mode: "permanent",
      enforcement: "explicit-delete",
    })
  })

  it("encrypts model output and keeps it for the content window only", () => {
    expect(routerFusionTablePolicy("fusionArtifacts")).toMatchObject({
      sensitivity: "confidential",
      contentProtection: "encrypted-content",
      retentionPolicy: { mode: "ttl", days: ROUTER_FUSION_ARTIFACT_CONTENT_DAYS },
    })
    for (const name of ["fusionRuns", "fusionCallAttempts", "fusionOutbox"]) {
      expect(routerFusionTablePolicy(name)?.retentionPolicy).toMatchObject({
        mode: "ttl",
        days: ROUTER_FUSION_RUN_TRAIL_DAYS,
      })
    }
    expect(routerFusionTablePolicy("messages")).toBeUndefined()
  })

  it("keeps a run's journal for the replay window and its snapshot for longer", () => {
    expect(routerFusionTablePolicy("fusionRunEvents")?.retentionPolicy).toMatchObject({
      mode: "ttl",
      days: ROUTER_FUSION_EVENT_HISTORY_DAYS,
    })
    // 410 EVENT_HISTORY_EXPIRED tells the client to read the snapshot, so the
    // snapshot must still be there when the journal is gone.
    expect(ROUTER_FUSION_EVENT_HISTORY_DAYS).toBeLessThan(ROUTER_FUSION_RUN_TRAIL_DAYS)
  })

  it("keeps an idempotency key for the spec's week, and feedback with its run", () => {
    // Spec §15.1: at least seven days, so a retried request replays its run.
    expect(routerFusionTablePolicy("fusionIdempotency")?.retentionPolicy).toMatchObject({
      mode: "ttl",
      days: ROUTER_FUSION_IDEMPOTENCY_DAYS,
    })
    expect(ROUTER_FUSION_IDEMPOTENCY_DAYS).toBeGreaterThanOrEqual(7)
    expect(ROUTER_FUSION_IDEMPOTENCY_DAYS).toBeLessThan(ROUTER_FUSION_RUN_TRAIL_DAYS)
    expect(routerFusionTablePolicy("fusionFeedback")?.retentionPolicy).toMatchObject({
      mode: "ttl",
      days: ROUTER_FUSION_RUN_TRAIL_DAYS,
    })
  })
})
