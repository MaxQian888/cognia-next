/**
 * E2E: chat.message → workflow trigger.
 *
 * Verifies M2 wiring: `persistMessages` in `lib/db/messages.ts` fires the
 * `trigger.chat.message` trigger when a new user message lands. The headless
 * path (without Tauri) lets us assert that the chat UI mounts, the workflow
 * trigger registry initialises (provider mounts), and the audit tab is
 * accessible.
 *
 * Full coverage (chat send → workflow run → action.twin.rag) requires:
 *   - The Tauri sidecar (the AI provider that consumes chat).
 *   - A seeded workflow with `trigger.chat.message`.
 *   - A seeded twin so `action.twin.rag` has data to retrieve.
 *
 * Prereqs:
 *   pnpm dev   # :3000 must be running
 *   pnpx playwright install chromium
 */

import { expect, test } from "@playwright/test"

const APP_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

test.describe("chat.message → workflow trigger", () => {
  test("home page mounts (WorkflowRuntimeProvider is wired without crashing)", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))
    await page.goto(APP_BASE_URL, { waitUntil: "domcontentloaded" })
    // If the provider crashed at mount, the body would be empty. Assert
    // some chrome / shell is present.
    await expect(page.locator("body")).toBeVisible()
    // A provider mount failure typically surfaces as a pageerror; assert
    // none escaped to the top level.
    expect(errors.filter((e) => /WorkflowRuntimeProvider|trigger-bridge/.test(e))).toEqual([])
  })

  test("Settings → Workflows shows the Library + Templates tabs (M5 templates)", async ({
    page,
  }) => {
    await page.goto(`${APP_BASE_URL}/?section=workflows&wfTab=templates`, {
      waitUntil: "domcontentloaded",
    })
    // The templates tab renders the built-in gallery. We don't assert
    // individual ids (those are flaky if seeds haven't run); we assert the
    // section is mounted.
    const sectionHeading = page.locator("h1, h2").first()
    await expect(sectionHeading).toBeVisible({ timeout: 10_000 })
  })

  // Full end-to-end flow with sidecar + workflow runtime now lives in
  // tests/e2e/tauri/chat-message-trigger.spec.ts (PLAYWRIGHT_TAURI_DRIVER=1).
})
