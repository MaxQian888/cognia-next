/**
 * Browser E2E: durable Pet nurture lifecycle.
 *
 * The app must create the singleton profile, hatch it through the real Pet
 * runtime, persist a rename, and route a direct care action through the event
 * bus/controller into both the profile and append-only activity ledger. A full
 * document reload then proves those mutations are durable rather than UI-only.
 *
 * The transparent `/pet-overlay` and `/pet-popup` windows are intentionally not
 * covered here: their window role, click-through, positioning, and cross-webview
 * bridge contracts require the real Tauri shell.
 */

import { expect, test } from "@playwright/test"

import { ensureCogniaAccount, readDexieRow, readDexieRows } from "../helpers/db-reset"

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

test.describe("pet — durable nurture lifecycle", () => {
  test("hatches, renames, nurtures, and restores the persisted pet", async ({ page }) => {
    // Each Playwright test owns a fresh browser context, so only the account
    // gate needs bootstrapping. Avoid the broad reset bridge here: wiring that
    // bridge imports the plugin runtime and would couple this Pet contract to
    // dynamic plugin-table schema upgrades before the test can even begin.
    await page.goto("/")
    await ensureCogniaAccount(page)

    // Mount PetMount after account activation so its real initialization effect
    // creates a fresh singleton profile instead of seeding a synthetic row.
    await page.goto("about:blank")
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
