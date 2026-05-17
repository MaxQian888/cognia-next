/**
 * Tests for performance-tier-prefs.ts — Dexie load/save round-trips.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { loadPerformanceTierPref, savePerformanceTierPref } from "./performance-tier-prefs"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("loadPerformanceTierPref", () => {
  it("returns 'auto' when no preference has been saved yet", async () => {
    expect(await loadPerformanceTierPref()).toBe("auto")
  })

  it("treats a non-tier value in settings as 'auto'", async () => {
    // Simulate a malformed value sneaking past the type system (e.g., from a
    // hand-edited backup).
    await getDb().settings.put({
      id: "singleton",
      // @ts-expect-error — intentional bad shape
      workflowEditorPerformanceTier: "nonsense",
    })
    expect(await loadPerformanceTierPref()).toBe("auto")
  })
})

describe("savePerformanceTierPref", () => {
  it("round-trips each valid tier", async () => {
    for (const tier of ["auto", "high", "balanced", "reduced"] as const) {
      await savePerformanceTierPref(tier)
      expect(await loadPerformanceTierPref()).toBe(tier)
    }
  })

  it("does not clobber unrelated settings fields", async () => {
    // Seed an unrelated field.
    const before = await getSettings()
    expect(before.theme).toBeDefined()
    expect(before.language).toBe("en")

    await savePerformanceTierPref("balanced")

    const after = await getSettings()
    expect(after.workflowEditorPerformanceTier).toBe("balanced")
    expect(after.theme).toBe(before.theme)
    expect(after.language).toBe(before.language)
  })
})
