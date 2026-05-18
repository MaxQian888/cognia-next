/**
 * Playwright `test` fixture for the Tauri E2E project. Connects to the
 * Tauri-spawned WebView2 over CDP using the websocket endpoint published
 * by `tests/e2e/global-setup.ts` into `process.env.PLAYWRIGHT_TAURI_CDP_WS`.
 *
 * Each Tauri spec should import `test` / `expect` from this file instead of
 * `@playwright/test`. The fixture is worker-scoped — one browser per worker —
 * and reuses the WebView2's existing context + first page (Tauri only ever
 * has one renderer context per window).
 *
 * Why a fixture instead of `connectOptions.wsEndpoint` in the project config:
 * the CDP ws is resolved by globalSetup at runtime, but Playwright evaluates
 * project `connectOptions` at config-load time — before globalSetup runs.
 * Reading the env inside the fixture defers resolution to when the fixture
 * is constructed, which happens AFTER globalSetup.
 */

import {
  test as base,
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

type TauriWorkerFixtures = {
  browser: Browser
  context: BrowserContext
}

type TauriTestFixtures = {
  page: Page
}

// NOTE: Playwright's fixture-yield callback is conventionally named `use`,
// which collides with React's `use()` hook in eslint-plugin-react-hooks
// (react-hooks/rules-of-hooks). We rename it to `provide` here so the rule
// doesn't false-positive — the Playwright API is fully name-agnostic about
// this callback.
export const test = base.extend<TauriTestFixtures, TauriWorkerFixtures>({
  browser: [
    async ({}, provide) => {
      const ws = process.env.PLAYWRIGHT_TAURI_CDP_WS
      if (!ws) {
        throw new Error(
          "PLAYWRIGHT_TAURI_CDP_WS not set — did global-setup boot the Tauri shell? " +
            "Make sure PLAYWRIGHT_TAURI=1 is exported before running playwright."
        )
      }
      const browser = await chromium.connectOverCDP(ws)
      await provide(browser)
      await browser.close()
    },
    { scope: "worker" },
  ],
  context: [
    async ({ browser }, provide) => {
      const ctx = browser.contexts()[0] ?? (await browser.newContext())
      await provide(ctx)
    },
    { scope: "worker" },
  ],
  page: async ({ context }, provide) => {
    const page = context.pages()[0] ?? (await context.newPage())
    await provide(page)
  },
})

export { expect } from "@playwright/test"
