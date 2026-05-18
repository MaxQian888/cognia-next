/**
 * Tauri E2E: Codex "Reuse codex-cli" adopt flow.
 *
 * The dialog probes `~/.codex/auth.json` via `discoverCodexAuth` when the
 * Reuse panel mounts. Specs publish a synthetic payload through
 * `window.__cogniaE2ECodexDiscovery` so the adopt button surfaces without
 * touching the user's actual codex-cli state.
 *
 * Happy path: synthetic ChatGPT credential → click Adopt → codex account
 * saved in the unified vault.
 * Edge case: discovery returns null → "Reuse" radio is disabled and no
 * adopt button is rendered.
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"
import { setCodexDiscoveryOverride, type MockCodexDiscovery } from "../../helpers/codex-discovery"
import { listAccountsForProvider, resetSubscriptionState } from "../../helpers/subscription"

const SYNTHETIC_DISCOVERED: MockCodexDiscovery = {
  source: "file",
  authJsonPath: "/fake/.codex/auth.json",
  authMode: "chatgpt",
  tokens: {
    accessToken: "e2e-fake-codex-access",
    refreshToken: "e2e-fake-codex-refresh",
    idTokenRaw: "e2e-fake-id-token",
    email: "e2e-codex@example.com",
    chatgptPlanType: "plus",
    chatgptUserId: "user_e2e_codex",
  },
  lastRefreshIso: "2026-05-18T00:00:00Z",
}

test.describe("tauri: Codex Reuse adopt", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await resetSubscriptionState(page)
  })

  test("synthetic discovered credential is adoptable into the codex vault", async ({ page }) => {
    await setCodexDiscoveryOverride(page, SYNTHETIC_DISCOVERED)
    await page.goto("/settings?section=subscription&subTab=codex")

    await page.getByRole("button", { name: "Add account" }).first().click()

    const dialog = page.getByRole("dialog", { name: /Sign in with Codex/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    // Reuse mode is auto-selected when discovery returns a credential.
    await expect(dialog.getByText(/Reuse codex-cli/i)).toBeVisible()
    // The discovered email should render in the credential preview.
    await expect(dialog.getByText("e2e-codex@example.com")).toBeVisible({ timeout: 5_000 })

    await dialog.getByRole("button", { name: /Adopt this credential/i }).click()

    // Dialog closes on adopt; the vault now holds exactly one codex account.
    await expect(dialog).toBeHidden({ timeout: 10_000 })
    const accounts = await listAccountsForProvider(page, "codex")
    expect(accounts).toHaveLength(1)
  })

  test("null discovery disables the Reuse path", async ({ page }) => {
    await setCodexDiscoveryOverride(page, null)
    await page.goto("/settings?section=subscription&subTab=codex")

    await page.getByRole("button", { name: "Add account" }).first().click()

    const dialog = page.getByRole("dialog", { name: /Sign in with Codex/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    // OAuth mode is the default when no credential is discoverable; the
    // Reuse radio is disabled and the Adopt button never renders.
    await expect(dialog.getByRole("button", { name: /Adopt this credential/i })).toHaveCount(0)

    const accounts = await listAccountsForProvider(page, "codex")
    expect(accounts).toHaveLength(0)
  })
})
