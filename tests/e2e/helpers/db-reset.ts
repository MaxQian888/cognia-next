/**
 * Playwright helper: drop Dexie tables + storage between tests.
 *
 * The implementation relies on the dev-only bridge in
 * `lib/dev/expose-test-globals.tsx`, which hangs `__cogniaResetDb` off
 * `window` when the dev server boots with `NEXT_PUBLIC_E2E=1`. The
 * Playwright config injects that env var automatically; if you run a dev
 * server yourself, export `NEXT_PUBLIC_E2E=1` first.
 *
 * Pattern in a spec:
 *   test.beforeEach(async ({ page }) => {
 *     await page.goto("/")
 *     await resetCogniaDb(page)
 *   })
 *
 * `resetCogniaDb` waits for the bridge to mount before invoking, so callers
 * never race the initializer.
 */

import { expect, type Page } from "@playwright/test"

declare global {
  interface Window {
    __cogniaResetDb?: () => Promise<void>
    __cogniaTestGlobalsReady?: boolean
  }
}

export async function waitForTestGlobals(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(
    () => Boolean((window as { __cogniaTestGlobalsReady?: boolean }).__cogniaTestGlobalsReady),
    undefined,
    { timeout: timeoutMs }
  )
}

export async function resetCogniaDb(page: Page): Promise<void> {
  await waitForTestGlobals(page)
  const ok = await page.evaluate(async () => {
    const w = window as Window & {
      __cogniaResetDb?: () => Promise<void>
    }
    if (typeof w.__cogniaResetDb !== "function") return false
    await w.__cogniaResetDb()
    return true
  })
  expect(ok, "window.__cogniaResetDb should be callable").toBe(true)
}
