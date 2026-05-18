/**
 * Tauri E2E: Anthropic OAuth PKCE — paste-code exchange path.
 *
 * Flow under test:
 *   1. User opens Settings → Subscription → Anthropic and clicks "Add account".
 *   2. The PKCE dialog assembles `https://claude.ai/oauth/authorize?...` and
 *      hands it to `openUrl`. Under E2E the URL is captured into
 *      `window.__cogniaE2EOpenUrlCalls` instead of opening the system browser.
 *   3. User pastes the authorization code back into the dialog and clicks
 *      "Sign in".
 *   4. The dialog POSTs to `${mockBaseUrl}/v1/oauth/token` (the renderer
 *      published the mock URL via `__cogniaMockBaseUrls.anthropic`).
 *   5. `anthropic_oauth_save_pkce_result` persists the credential and the
 *      account row appears in the account list.
 *
 * Happy path: paste the bare code → account saved.
 * Edge case: paste `code#wrong-state` → state-mismatch error, no save.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import { configureMockBaseUrls } from "../../helpers/seed-workflow"
import {
  clearOpenUrlCalls,
  listAccountsForProvider,
  readOpenUrlCalls,
  resetSubscriptionState,
} from "../../helpers/subscription"

test.describe("tauri: Anthropic OAuth PKCE", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await resetSubscriptionState(page)
    await configureMockBaseUrls(page, { anthropic: process.env.E2E_ANTHROPIC_BASE_URL! })
    await clearOpenUrlCalls(page)
  })

  test("happy path: paste code → exchange → account saved", async ({ page }) => {
    await page.goto("/settings?section=subscription")

    // Open the add-account dialog.
    await page.getByRole("button", { name: "Add account" }).first().click()

    // Step 1: choose mode — Subscription is the default. Click "Open authorization page".
    const dialog = page.getByRole("dialog", { name: /Sign in with Claude/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole("button", { name: /Open authorization page/i }).click()

    // The renderer should have asked the OS to open the authorize URL; our
    // E2E hook captured it instead.
    const opened = await readOpenUrlCalls(page)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened[0]).toContain("/oauth/authorize")

    // Step 2: paste the authorization code and submit.
    const codeBox = dialog.getByLabel(/Authorization code/i)
    await expect(codeBox).toBeVisible()
    await codeBox.fill("e2e-test-authcode-happy")
    await dialog.getByRole("button", { name: /^Sign in$/i }).click()

    // Dialog auto-closes ~800ms after success.
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    // The account list under the Anthropic provider tab now has one entry.
    const accounts = await listAccountsForProvider(page, "anthropic")
    expect(accounts).toHaveLength(1)
  })

  test("state mismatch surfaces error and does not persist account", async ({ page }) => {
    await page.goto("/settings?section=subscription")
    await page.getByRole("button", { name: "Add account" }).first().click()

    const dialog = page.getByRole("dialog", { name: /Sign in with Claude/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole("button", { name: /Open authorization page/i }).click()

    // Paste a code with a `#state` suffix that won't match the freshly-rolled
    // PKCE state — the dialog must reject before hitting the mock.
    const codeBox = dialog.getByLabel(/Authorization code/i)
    await expect(codeBox).toBeVisible()
    await codeBox.fill("e2e-test-authcode#deliberately-wrong-state")
    await dialog.getByRole("button", { name: /^Sign in$/i }).click()

    // Error banner appears; dialog stays open; no account written.
    await expect(dialog.getByText(/state/i)).toBeVisible({ timeout: 5_000 })
    await expect(dialog).toBeVisible()

    const accounts = await listAccountsForProvider(page, "anthropic")
    expect(accounts).toHaveLength(0)
  })
})
