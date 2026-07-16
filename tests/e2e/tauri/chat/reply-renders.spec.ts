/**
 * Tauri E2E: the CORE chat flow — compose → real Claude sidecar → stream →
 * rendered assistant bubble.
 *
 * This is the single most important product path and had ZERO automated
 * coverage before this spec: the web specs stub `@/lib/claude/ipc`, the
 * Jest "main-flow" integration test hand-fakes the SDK event shapes, and the
 * other Tauri chat spec asserts only a workflow run row (never an assistant
 * reply). Here the REAL sidecar is spawned by Rust on `claude_send`, runs the
 * real `@anthropic-ai/claude-agent-sdk`, and streams a reply back through the
 * real renderer.
 *
 * Hermeticity: the sidecar is pointed at the in-process mock Anthropic server
 * via `ANTHROPIC_BASE_URL` injected into the Tauri process by
 * `tests/e2e/helpers/tauri-cdp-launch.ts` (the global-setup mock defaults to
 * the `echo` scenario, which now also streams SSE for `stream: true` requests
 * — see `tests/e2e/mocks/anthropic/server.ts`). The assistant reply therefore
 * carries the unique `mock-anthropic-echo` marker, which real Anthropic could
 * never produce — so its presence proves the turn round-tripped through the
 * real sidecar AND the mock, not the network.
 *
 * Runs only under the `tauri` Playwright project (PLAYWRIGHT_TAURI=1) — the
 * Windows-only `e2e-tauri` CI job (schedule/dispatch). Note: between
 * 2026-05-19 and 2026-07-16 this suite never actually executed anywhere — a
 * fixture-scope bug made the project collect 0 tests (see
 * tests/e2e/tauri/fixtures.ts).
 */

import { expect, test } from "../fixtures"
import { resetCogniaDb } from "../../helpers/db-reset"

test.describe("tauri: chat reply renders from the real sidecar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("sending a message renders a streamed assistant reply", async ({ page }) => {
    await page.goto("/")
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    await composer.fill("ping from e2e reply-renders")
    await composer.press("Enter")

    // The assistant bubble streamed back from the real sidecar carries the
    // mock's echo marker — proof it came from the sidecar+mock, not the network.
    await expect(page.getByText(/mock-anthropic-echo/i).first()).toBeVisible({ timeout: 60_000 })
  })

  test("the run settles back to idle after the reply", async ({ page }) => {
    await page.goto("/")
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 30_000 })

    await composer.fill("settle check")
    await composer.press("Enter")

    await expect(page.getByText(/mock-anthropic-echo/i).first()).toBeVisible({ timeout: 60_000 })

    // Once the turn settles, the composer is interactive again and a brand-new
    // message can be typed (a session stuck "streaming" would block this).
    await expect(composer).toBeEditable({ timeout: 30_000 })
    await composer.fill("second message after settle")
    await expect(composer).toHaveValue("second message after settle")
  })
})
