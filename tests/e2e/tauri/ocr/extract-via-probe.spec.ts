/**
 * Tauri E2E: OCR extract round-trip via the per-provider Probe button.
 *
 * The Probe button on a provider's Config tab calls `lib/ocr/probe.ts`,
 * which runs `extract()` against a 1×1 transparent PNG. Under E2E we
 * install `window.__cogniaE2EOcrMock` so extract() short-circuits to a
 * canned result — this lets us verify the full UI round-trip (click →
 * extract() call → result alert) without depending on real cloud keys or
 * native binaries.
 *
 * Happy path: mock returns success → success alert appears.
 * Edge path: mock throws → destructive alert appears.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import { clearOcrMock, installOcrMock } from "../../helpers/ocr-mock"

test.describe("tauri: OCR probe round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await clearOcrMock(page)
  })

  test("happy path: mock provider returns a result → success alert", async ({ page }) => {
    await installOcrMock(page, {
      kind: "success",
      result: {
        providerId: "tesseract-wasm",
        pages: [{ pageNumber: 1, text: "ok", markdown: "ok" }],
        combinedMarkdown: "ok",
        combinedText: "ok",
        languages: ["en"],
        durationMs: 12,
        cached: false,
      },
    })

    await page.goto("/settings?section=ocr")
    await page.getByTestId("ocr-sidebar-item-tesseract-wasm").click()
    await expect(page.getByTestId("ocr-config-tab")).toBeVisible({ timeout: 10_000 })

    await page.getByTestId("ocr-probe-button").click()

    const alert = page.getByTestId("ocr-probe-alert")
    await expect(alert).toBeVisible({ timeout: 10_000 })
    // The success variant is the `default` Alert; the failure variant carries
    // the `destructive` class via cva. We assert by class to avoid coupling
    // to translation strings.
    const className = await alert.getAttribute("class")
    expect(className ?? "").not.toMatch(/destructive/)
  })

  test("edge: mock provider throws → destructive alert", async ({ page }) => {
    await installOcrMock(page, {
      kind: "error",
      code: "credentials_missing",
      message: "e2e mock denied",
    })

    await page.goto("/settings?section=ocr")
    await page.getByTestId("ocr-sidebar-item-tesseract-wasm").click()
    await expect(page.getByTestId("ocr-config-tab")).toBeVisible({ timeout: 10_000 })

    await page.getByTestId("ocr-probe-button").click()

    const alert = page.getByTestId("ocr-probe-alert")
    await expect(alert).toBeVisible({ timeout: 10_000 })
    const className = await alert.getAttribute("class")
    expect(className ?? "").toMatch(/destructive/)
  })
})
