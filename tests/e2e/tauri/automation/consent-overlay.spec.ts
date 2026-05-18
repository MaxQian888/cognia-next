/**
 * Tauri E2E: automation consent overlay flow.
 *
 * The renderer-side `ConsentOverlay` listens for `automation:consent-request`
 * Tauri events and renders a dialog so the user can Allow / Allow-session /
 * Reject. Specs publish a synthetic event via `@tauri-apps/api/event`'s
 * `emit()`, then drive the three buttons and assert the overlay closes.
 *
 * The corresponding `automation_consent_respond` IPC will fire against the
 * real Rust gate. Because no actual `ConsentBroker::request` is pending the
 * Rust side returns "unknown id" — the overlay's catch swallows that, which
 * is exactly the failure mode we want to be tolerant of.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

const FAKE_EVENT_PAYLOAD = {
  id: "e2e-consent-1",
  command: "click",
  surface: "renderer",
  pluginId: null,
  processName: null,
  windowTitle: "E2E target",
  timeoutMs: 30_000,
}

async function emitConsentEvent(
  page: import("@playwright/test").Page,
  payload: Record<string, unknown>
): Promise<void> {
  await page.evaluate(async (p) => {
    const { emit } = await import("@tauri-apps/api/event")
    await emit("automation:consent-request", p)
  }, payload)
}

test.describe("tauri: automation consent overlay", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("emitting consent-request renders overlay; Allow once closes it", async ({ page }) => {
    await emitConsentEvent(page, { ...FAKE_EVENT_PAYLOAD, id: "e2e-allow-once" })

    const overlay = page.getByRole("dialog", { name: /consent|permission|automation/i })
    await expect(overlay).toBeVisible({ timeout: 5_000 })

    // Allow once is the default action (first button in the column).
    await overlay.getByRole("button").first().click()
    await expect(overlay).toBeHidden({ timeout: 5_000 })
  })

  test("reject button dismisses the overlay", async ({ page }) => {
    await emitConsentEvent(page, { ...FAKE_EVENT_PAYLOAD, id: "e2e-reject" })

    const overlay = page.getByRole("dialog", { name: /consent|permission|automation/i })
    await expect(overlay).toBeVisible({ timeout: 5_000 })

    // The reject button is rendered last in the action column with the
    // `ghost` variant — match by the localized label fragment.
    const buttons = overlay.getByRole("button")
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThanOrEqual(3)
    // Click the last button (Reject in our layout).
    await buttons.nth(buttonCount - 1).click()
    await expect(overlay).toBeHidden({ timeout: 5_000 })
  })
})
