/**
 * Tauri E2E: plugin_permission_list / plugin_permission_grant /
 * plugin_permission_revoke IPC contracts.
 *
 * Asserts the renderer can grant and read back permissions for a plugin id
 * that doesn't exist in the runtime registry — this is the path the install
 * dialog uses to provisionally record requested permissions before the
 * plugin is fully loaded.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

const FAKE_PLUGIN_ID = "e2e-test-plugin"

test.describe("tauri: plugin permission IPC", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("grant → list → revoke round-trip", async ({ page }) => {
    const empty = await page.evaluate(async (id) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return (await invoke("plugin_permission_list", { pluginId: id })) as string[]
    }, FAKE_PLUGIN_ID)
    expect(empty).toEqual([])

    await page.evaluate(async (id) => {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_permission_grant", {
        request: { pluginId: id, permission: "filesystem.read" },
      })
    }, FAKE_PLUGIN_ID)

    const afterGrant = await page.evaluate(async (id) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return (await invoke("plugin_permission_list", { pluginId: id })) as string[]
    }, FAKE_PLUGIN_ID)
    expect(afterGrant).toContain("filesystem.read")

    await page.evaluate(async (id) => {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_permission_revoke", {
        request: { pluginId: id, permission: "filesystem.read" },
      })
    }, FAKE_PLUGIN_ID)

    const afterRevoke = await page.evaluate(async (id) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return (await invoke("plugin_permission_list", { pluginId: id })) as string[]
    }, FAKE_PLUGIN_ID)
    expect(afterRevoke).not.toContain("filesystem.read")
  })
})
