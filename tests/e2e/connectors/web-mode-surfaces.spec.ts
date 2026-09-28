/**
 * Playwright E2E — connector surfaces in the browser (web mode).
 *
 * Scope note: the actual Telegram bidirectional flow (inbound update → AI →
 * outbound sendMessage) requires the connector runtime's HTTP layer, which
 * runs through Tauri commands — it CANNOT execute in a plain browser. That
 * round-trip is covered by tests/e2e/tauri/telegram-bidirectional.spec.ts
 * (nightly Windows job). What web mode owns is the read-only degradation
 * story, and that is what this spec pins:
 *   - Settings → Connections explains its host capability requirement.
 *   - /inbox directs an unpaired browser to connect a host.
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

import { test, expect } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("connectors — web-mode surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await page.goto("about:blank")
  })

  test("@smoke Settings → Connections explains the host capability boundary", async ({ page }) => {
    await page.goto("/settings?section=connections", { waitUntil: "domcontentloaded" })
    await expect(page.getByText("Not available on this host", { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      page.getByText(/needs the desktop app, or a paired host that runs it/i)
    ).toBeVisible()
  })

  test("inbox explains the missing host and opens pairing", async ({ page }) => {
    await page.goto("/inbox", { waitUntil: "domcontentloaded" })
    await expect(page.getByText("Connect a host to use the Inbox", { exact: true })).toBeVisible()
    await expect(
      page.getByText(
        "This device doesn't run connector bots. Pair it with your desktop or server to read and reply to platform conversations."
      )
    ).toBeVisible()
    await page.getByRole("button", { name: "Pair a host", exact: true }).click()
    await expect(page).toHaveURL(/\/pair(?:[/?#]|$)/)
  })
})
