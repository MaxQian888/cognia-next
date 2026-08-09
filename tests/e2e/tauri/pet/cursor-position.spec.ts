/**
 * Windows Tauri E2E: the least-privilege pet cursor IPC returns only finite
 * screen coordinates. The command is local-only and carries no persistence or
 * network surface.
 */

import { expect, test } from "../fixtures"

test.describe("tauri: pet cursor position", () => {
  test("returns a finite x/y coordinate pair", async ({ page }) => {
    await page.goto("/")
    const position = await page.evaluate(async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      return await invoke<{ x: number; y: number }>("pet_window_get_cursor_position")
    })

    expect(position).not.toBeNull()
    expect(Number.isFinite(position?.x)).toBe(true)
    expect(Number.isFinite(position?.y)).toBe(true)
    expect(Object.keys(position ?? {}).sort()).toEqual(["x", "y"])
  })
})
