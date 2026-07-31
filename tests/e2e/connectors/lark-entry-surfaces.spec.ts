/**
 * Playwright E2E — the Feishu web entry pages (`/lark/entry`, `/lark/shortcut`).
 *
 * These two routes are the only part of the dual-entry epic that a browser can
 * exercise end to end: everything behind them (SSO exchange, entry-token
 * redemption, membership checks, message import) lives in the headless Rust
 * companion and the brain, and is covered by their own suites.
 *
 * What a browser CAN prove, and what nothing covered before, is that the pages
 * reach a terminal, explained state instead of a permanent spinner — including
 * the `+`-menu branch, which until recently had no caller at all and always
 * failed as `trigger_missing`.
 *
 * The companion base URL is left unset, so the client's fetch has no host to
 * reach; every case here is therefore decided by the launch query alone, with
 * no network dependency and no mock server to drift.
 */

import { test, expect } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("lark web entry surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("/lark/entry with no token reaches a terminal explanation, not a spinner", async ({
    page,
  }) => {
    await page.goto("/lark/entry", { waitUntil: "domcontentloaded" })

    const shell = page.getByTestId("lark-entry")
    await expect(shell).toBeVisible({ timeout: 15_000 })
    // The spinner has role=status; a terminal state replaces it with the
    // explanation plus a way out.
    await expect(shell.getByRole("status")).toBeHidden({ timeout: 15_000 })
    await expect(shell.getByRole("link")).toBeVisible()
  })

  test("/lark/shortcut opened from the + menu does not report a missing trigger", async ({
    page,
  }) => {
    // The `+` menu carries chat context and no trigger code. Before it was
    // wired, this exact URL ended in `trigger_missing` — a message telling the
    // user to "open this page via the message shortcut" when they had not used
    // the message shortcut. With the branch reachable and no SSO session yet,
    // the correct outcome is the login bounce, so the assertion is on where
    // the page goes rather than on copy it no longer renders.
    await page.goto("/lark/shortcut?adapter_id=lk-e2e&chat_id=oc_e2e", {
      waitUntil: "domcontentloaded",
    })

    await expect(page).toHaveURL(/\/integrations\/lark\/web\/login/, { timeout: 20_000 })
    expect(page.url()).toContain("adapter_id=lk-e2e")
  })

  test("/lark/shortcut with neither a trigger nor a chat says which context is missing", async ({
    page,
  }) => {
    await page.goto("/lark/shortcut?adapter_id=lk-e2e", { waitUntil: "domcontentloaded" })

    const shell = page.getByTestId("lark-shortcut")
    await expect(shell).toBeVisible({ timeout: 15_000 })
    await expect(shell.getByRole("status")).toBeHidden({ timeout: 20_000 })
    // Terminal, with an escape hatch to the workbench rather than a dead end.
    await expect(shell.getByRole("link")).toBeVisible()
  })

  test("both entry pages render without a companion configured", async ({ page }) => {
    // A desktop install has no `/integrations/lark/*` at all. The pages must
    // still degrade to an explanation instead of throwing on a failed fetch.
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))

    await page.goto("/lark/entry?entry=not-a-real-token", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("lark-entry")).toBeVisible({ timeout: 15_000 })

    await page.goto("/lark/shortcut?adapter_id=lk-e2e&chat_id=oc_e2e", {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByTestId("lark-shortcut")).toBeVisible({ timeout: 15_000 })

    expect(errors, `unhandled page errors: ${errors.join(", ")}`).toEqual([])
  })
})
