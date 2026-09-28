/**
 * Windows Tauri E2E: real Pet cursor IPC, durable nurture lifecycle, and local
 * gaze preference. These positive journeys require the desktop host; browser
 * companions verify the denial boundary instead.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb, readDexieRow, readDexieRows } from "../../helpers/db-reset"

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

interface PersistedPetProfile {
  id: "global"
  soul: { name: string; personality: string; hatchDate: string } | null
  xp: number
  coins?: number
  needs: {
    energy: number
    mood: number
    bond: number
    lastTickAt: string
  }
}

interface PersistedPetActivity {
  id?: number
  kind: string
  source: string
  xp: number
  ts: number
}

const RENAMED_PET = "E2E Sprout"

test.describe("tauri: pet — durable nurture lifecycle", () => {
  test("hatches, renames, nurtures, and restores the persisted pet", async ({ page }) => {
    // Wait for account and plugin initialization before entering the Pet route;
    // the shared feature fixture also completes unrelated onboarding.
    await page.goto("/")
    await resetCogniaDb(page)

    // Mount PetMount after account activation so its real initialization effect
    // creates a fresh singleton profile instead of seeding a synthetic row.
    await page.goto("/pet", { waitUntil: "domcontentloaded" })

    const hatch = page.getByTestId("pet-hatch")
    await expect(hatch).toBeVisible()
    await hatch.getByRole("button").click()

    await expect(page.getByTestId("pet-nurture-tab")).toBeVisible()
    await expect
      .poll(() => readDexieRow<PersistedPetProfile>(page, { table: "petProfile", key: "global" }))
      .toMatchObject({ id: "global", soul: expect.objectContaining({ name: expect.any(String) }) })

    // Enter the shared inline editor from the identity header and persist a
    // deterministic name so the reload assertion is independent of soul RNG.
    await page.locator("header").getByRole("button").first().click()
    const editor = page.getByTestId("pet-name-editor")
    await editor.getByRole("textbox").fill(RENAMED_PET)
    await editor.getByRole("textbox").press("Enter")
    await expect(page.locator("header").getByText(RENAMED_PET, { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const row = await readDexieRow<PersistedPetProfile>(page, {
          table: "petProfile",
          key: "global",
        })
        return row?.soul?.name
      })
      .toBe(RENAMED_PET)

    const beforeCare = await readDexieRow<PersistedPetProfile>(page, {
      table: "petProfile",
      key: "global",
    })
    expect(beforeCare?.soul, "the pet should be hatched before nurture").not.toBeNull()

    await page.getByTestId("pet-action-grid").locator('[data-action="fed"]').click()
    await expect(page.getByTestId("pet-cooldown-fed")).toBeVisible()

    await expect
      .poll(async () => {
        const profile = await readDexieRow<PersistedPetProfile>(page, {
          table: "petProfile",
          key: "global",
        })
        const activity = await readDexieRows<PersistedPetActivity>(page, {
          table: "petActivityLog",
        })
        return { profile, activity }
      })
      .toMatchObject({
        profile: {
          id: "global",
          soul: { name: RENAMED_PET },
          xp: expect.any(Number),
          coins: expect.any(Number),
        },
        activity: [
          expect.objectContaining({ kind: "fed", source: "user", xp: expect.any(Number) }),
        ],
      })

    const persistedAfterCare = await readDexieRow<PersistedPetProfile>(page, {
      table: "petProfile",
      key: "global",
    })
    expect(persistedAfterCare?.xp).toBeGreaterThan(beforeCare?.xp ?? 0)
    expect(persistedAfterCare?.coins ?? 0).toBeGreaterThan(beforeCare?.coins ?? 0)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("pet-nurture-tab")).toBeVisible()
    await expect(page.locator("header").getByText(RENAMED_PET, { exact: true })).toBeVisible()

    const restored = await readDexieRow<PersistedPetProfile>(page, {
      table: "petProfile",
      key: "global",
    })
    expect(restored?.soul?.name).toBe(RENAMED_PET)
    expect(restored?.xp).toBe(persistedAfterCare?.xp)
    expect(restored?.coins).toBe(persistedAfterCare?.coins)
  })
})

test.describe("tauri: pet — governed appearance", () => {
  test("persists the local-only gaze preference", async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await page.goto("/settings?section=pet", { waitUntil: "domcontentloaded" })

    const gaze = page.getByRole("switch", { name: "Follow pointer" })
    await expect(gaze).toBeVisible()
    await expect(gaze).toBeChecked()
    await gaze.click()
    await expect(gaze).not.toBeChecked()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("switch", { name: "Follow pointer" })).not.toBeChecked()
  })
})
