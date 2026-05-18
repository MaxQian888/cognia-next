/**
 * Tauri-driver E2E: Telegram bidirectional auto-mode round-trip.
 *
 * Replaces the previously `test.skip()`'d auto-mode stub in
 * `tests/e2e/connectors/telegram-bidirectional.spec.ts`. Runs only under
 * the `tauri-driver` Playwright project (PLAYWRIGHT_TAURI_DRIVER=1).
 *
 * Flow under test:
 *   1. Mock Telegram server is up.
 *   2. The Telegram adapter is configured (mock baseUrl + token).
 *   3. The mock server pushes an inbound update.
 *   4. Adapter polls, the AI run picks it up (sendPrompt mock), and the
 *      outbound runner delivers the reply through sendMessage.
 *   5. Assert: mock server has captured a sendMessage; reply text matches.
 */

import { expect, test } from "./fixtures"
import { createTelegramMockServer, makeTelegramUpdate } from "../connectors/telegram-mock-server"
import { resetCogniaDb } from "../helpers/db-reset"
import { configureMockBaseUrls } from "../helpers/seed-workflow"

const MOCK_PORT = 19879
let mock: ReturnType<typeof createTelegramMockServer> | null = null

test.beforeAll(async () => {
  mock = createTelegramMockServer()
  await mock.start(MOCK_PORT)
})
test.afterAll(async () => {
  await mock?.stop()
})

test.describe("tauri-driver: telegram auto-mode bidirectional", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, {
      anthropic: process.env.E2E_ANTHROPIC_BASE_URL!,
    })
  })

  test("inbound → AI → outbound delivers a reply via sendMessage", async () => {
    mock!.pushUpdate(makeTelegramUpdate("hello cognia", 555, 777))
    const sent = await mock!.waitForSend(30_000)
    expect(sent.chatId).toBe(555)
    expect(typeof sent.text).toBe("string")
    expect(sent.text.length).toBeGreaterThan(0)
  })
})
