/**
 * Tauri E2E: OCR settings sidebar renders the expected provider catalogue.
 *
 * The OCR settings section ships a fixed registry of 17 providers grouped
 * into 5 categories plus a pinned Auto-Router pseudo-entry. This spec
 * verifies the catalogue actually paints in the Tauri shell — a regression
 * here would be a sign that platform-aware filtering accidentally hid an
 * always-available provider.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

/**
 * Provider ids guaranteed to surface on every desktop shell — drawn from
 * `components/settings/ocr/ocr-section.tsx::OCR_PROVIDER_REGISTRY`. Cloud
 * providers (no shell restriction) and the WASM/desktop locals are always
 * present; mobile-only providers (mlkit-android) are excluded.
 */
const ALWAYS_VISIBLE_PROVIDER_IDS = [
  "mistral-ocr",
  "google-vision",
  "aws-textract",
  "anthropic-vision",
  "openai-vision",
  "gemini-vision",
  "tesseract-wasm",
  "ocr-space",
  "mathpix",
  "lark-basic",
]

test.describe("tauri: OCR settings sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("renders the auto-router + every always-visible provider", async ({ page }) => {
    await page.goto("/settings?section=ocr")

    await expect(page.getByTestId("ocr-section")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("ocr-auto-router-item")).toBeVisible()

    for (const id of ALWAYS_VISIBLE_PROVIDER_IDS) {
      await expect(page.getByTestId(`ocr-sidebar-item-${id}`)).toBeVisible({
        timeout: 5_000,
      })
    }
  })

  test("selecting auto-router shows the auto-router panel", async ({ page }) => {
    await page.goto("/settings?section=ocr")

    await page.getByTestId("ocr-auto-router-item").click()
    await expect(page.getByTestId("ocr-auto-router-panel")).toBeVisible({ timeout: 5_000 })
  })
})
