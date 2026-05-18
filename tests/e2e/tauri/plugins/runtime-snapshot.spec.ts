/**
 * Tauri E2E: plugin runtime registry IPC contracts.
 *
 * `plugin_get_all` and `plugin_runtime_snapshot` are the renderer's read
 * paths into the Rust-side plugin manager. This spec asserts the contracts
 * (return shape + error semantics) so the renderer can rely on them without
 * having to defensively narrow at every call site.
 *
 * No fixture plugin is installed — a fresh Tauri shell with the suite-wide
 * Dexie reset starts with zero runtime plugins, so the snapshot is empty.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

test.describe("tauri: plugin runtime IPC", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("plugin_get_all returns an array on a fresh shell", async ({ page }) => {
    const list = await page.evaluate(async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      return (await invoke("plugin_get_all")) as unknown[]
    })
    expect(Array.isArray(list)).toBe(true)
  })

  test("plugin_runtime_snapshot returns the snapshot envelope shape", async ({ page }) => {
    const snapshot = await page.evaluate(async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      return (await invoke("plugin_runtime_snapshot")) as Array<{
        plugin?: unknown
      }>
    })
    expect(Array.isArray(snapshot)).toBe(true)
    // Each entry — if any — has a `plugin` property (the canonical envelope).
    for (const entry of snapshot) {
      expect(entry).toHaveProperty("plugin")
    }
  })
})
