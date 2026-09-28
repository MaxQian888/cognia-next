/**
 * E2E: mobile backup — export → wipe → import round-trip (ADR-0001).
 *
 * This is the highest-consequence subsystem in the app (irreversible user
 * data loss) and its previous E2E was the shallowest test in the suite: one
 * assertion that an export button was visible and enabled — on /me, where
 * the backup surface doesn't even live (it's /me/backup). This spec drives
 * the full loop through real product code: seed distinctive data → encrypted
 * export lands in the (mock) filesystem → wipe the database → import the
 * exported envelope back through the file input, decrypting with the
 * passphrase → the seeded data exists again.
 *
 * Writing it immediately exposed a real data-loss defect: the mobile import
 * path never decrypted (mobile exports are ALWAYS encrypted), so a phone
 * could never restore its own backup. Fixed alongside this spec in
 * components/mobile/backup/mobile-backup-section.tsx.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import {
  bootstrapCogniaMobile,
  readDexieRow,
  setCogniaSettings,
  waitForTestGlobals,
} from "../helpers/db-reset"
import { decryptBackupPackage } from "@/lib/data/crypto"
import type { BackupPackageV3, EncryptedEnvelopeV1 } from "@/lib/data/types"
import { injectCapacitor } from "../helpers/inject-capacitor"

const PASSPHRASE = "e2e-roundtrip-pass"
const CHARACTER_NAME = "E2E Backup Round-Trip Character"

async function readBackupFiles(
  page: import("@playwright/test").Page
): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const snap = (
      window as unknown as {
        __cogniaCapMock: { filesystemSnapshot(): Record<string, string> }
      }
    ).__cogniaCapMock.filesystemSnapshot()
    return Object.fromEntries(Object.entries(snap).filter(([path]) => path.includes("backups")))
  })
}

async function readBackupFile(
  page: import("@playwright/test").Page,
  before: Record<string, string> = {}
): Promise<string | null> {
  return (
    Object.entries(await readBackupFiles(page)).find(
      ([path, data]) => before[path] !== data
    )?.[1] ?? null
  )
}

test.describe("mobile — backup round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "standalone", {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-09-28T00:00:00.000Z",
      },
    })
    await expect(page.getByRole("tablist", { name: "Main navigation" })).toBeVisible()
    await waitForTestGlobals(page, 30_000)
  })

  test("@critical export → wipe → import restores the seeded data", async ({ page }) => {
    // 1. Seed a distinctive row the round-trip must preserve.
    const charId = await page.evaluate(async (name) => {
      const w = window as Window & {
        __cogniaSeedCharacter?: (d: { name: string; systemPrompt?: string }) => Promise<string>
      }
      if (typeof w.__cogniaSeedCharacter !== "function") {
        throw new Error("__cogniaSeedCharacter bridge missing")
      }
      return await w.__cogniaSeedCharacter({ name, systemPrompt: "backup-roundtrip-marker" })
    }, CHARACTER_NAME)
    expect(charId).toBeTruthy()

    // 2. Export with a passphrase; the mobile saveExport path writes the
    //    encrypted envelope into the Capacitor Filesystem (mocked, so the
    //    spec can read the bytes back).
    await page.goto("/me/backup")
    const passphrase = page.getByTestId("backup-passphrase")
    await expect(passphrase).toBeVisible({ timeout: 15_000 })
    await passphrase.fill(PASSPHRASE)
    await page.getByTestId("backup-export").click()

    await expect
      .poll(async () => (await readBackupFile(page)) !== null, { timeout: 20_000 })
      .toBe(true)
    // Capacitor Filesystem writes base64 payloads — decode to the envelope JSON.
    const envelope = Buffer.from((await readBackupFile(page))!, "base64").toString("utf-8")

    // The export is an encrypted envelope, never plaintext.
    const parsedEnvelope = JSON.parse(envelope) as EncryptedEnvelopeV1
    expect(parsedEnvelope.version).toBe("enc-v1")
    expect(envelope).not.toContain(CHARACTER_NAME)

    // 3. Wipe. The seeded character must be gone.
    await page.evaluate(async () => {
      if (!window.__cogniaResetDb) throw new Error("Database reset bridge unavailable")
      await window.__cogniaResetDb()
    })
    await setCogniaSettings(page, {
      mobileRuntimeMode: "standalone",
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-09-28T00:00:00.000Z",
      },
    })
    expect(
      await readDexieRow<{ name?: string }>(page, { table: "characters", key: charId })
    ).toBeUndefined()

    // 4. Import the exported envelope back (decrypts with the passphrase).
    await page.goto("/me/backup")
    await page.getByTestId("backup-passphrase").fill(PASSPHRASE)
    await page.getByTestId("backup-import-input").setInputFiles({
      name: "roundtrip.cog.bak",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(envelope, "utf-8"),
    })
    await expect(page.getByText(/restore complete|恢复完成/i)).toBeVisible({ timeout: 30_000 })

    // 5. Re-export the restored database through the real product path. Raw
    // IndexedDB contains ciphertext, so verify its decrypted persisted content
    // through the portable backup rather than expecting plaintext storage.
    const beforeReexport = await readBackupFiles(page)
    await page.getByTestId("backup-export").click()
    await expect
      .poll(() => readBackupFile(page, beforeReexport), { timeout: 20_000 })
      .not.toBeNull()
    const restoredEnvelopeText = Buffer.from(
      (await readBackupFile(page, beforeReexport))!,
      "base64"
    ).toString("utf-8")
    expect(restoredEnvelopeText).not.toContain(CHARACTER_NAME)
    const restoredPackage = JSON.parse(
      await decryptBackupPackage(
        JSON.parse(restoredEnvelopeText) as EncryptedEnvelopeV1,
        PASSPHRASE
      )
    ) as BackupPackageV3
    expect(
      restoredPackage.payload.characters?.find((character) => character.id === charId)
    ).toMatchObject({
      id: charId,
      name: CHARACTER_NAME,
      systemPrompt: "backup-roundtrip-marker",
    })
  })
})
