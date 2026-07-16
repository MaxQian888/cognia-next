/**
 * Playwright E2E — connector surfaces in the browser (web mode).
 *
 * Scope note: the actual Telegram bidirectional flow (inbound update → AI →
 * outbound sendMessage) requires the connector runtime's HTTP layer, which
 * runs through Tauri commands — it CANNOT execute in a plain browser. That
 * round-trip is covered by tests/e2e/tauri/telegram-bidirectional.spec.ts
 * (nightly Windows job). What web mode owns is the read-only degradation
 * story, and that is what this spec pins:
 *   - Settings → Connections shows the web-mode banner.
 *   - /inbox renders its shell for a signed-in account.
 *
 * An earlier version wrapped both assertions in `.catch(() => test.skip())`
 * (self-nullifying — the banner or inbox regressing reported green), asserted
 * against a testid the shell never rendered (inbox-sidebar vs
 * inbox-sidebar-pane), hardcoded http://localhost:3000, went to
 * `/?section=connections` (the section lives on /settings), and carried
 * three tests that only exercised the mock Telegram server against itself.
 * Those mock self-tests are deleted — the mock's behavior is its own
 * concern, not product coverage.
 */

import { test, expect } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("connectors — web-mode surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("Settings → Connections shows the web-mode banner (no Tauri)", async ({ page }) => {
    await page.goto("/settings?section=connections", { waitUntil: "domcontentloaded" })
    const banner = page.getByRole("status", { name: /web mode banner/i })
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText(/desktop/i)
  })

  test("inbox renders the sidebar shell", async ({ page }) => {
    await page.goto("/inbox", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: 15_000 })
    // The sidebar's real furniture: the view-mode switch and the adapters
    // rail (empty-state copy included — no adapters are configured in web
    // mode after a reset).
    await expect(page.getByRole("radiogroup", { name: /view mode/i })).toBeVisible()
    await expect(page.getByText(/no adapters/i).first()).toBeVisible()
  })
})
