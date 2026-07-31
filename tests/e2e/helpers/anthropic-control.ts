/**
 * Spec-side control of the SHARED mock Anthropic server booted by
 * `tests/e2e/global-setup.ts`. The Tauri sidecar reaches that server over
 * `ANTHROPIC_BASE_URL` (see `helpers/tauri-cdp-launch.ts`); these helpers reach
 * the SAME instance over HTTP from the Playwright node process, so a Tauri chat
 * spec can drive the real compose → sidecar → stream → render path through an
 * error or slow-stream scenario instead of the default `echo`.
 *
 * Always pair `setAnthropicScenario(...)` with `resetAnthropic()` in
 * `afterEach` — the instance is shared across the whole run, so a leftover
 * non-echo scenario would bleed into unrelated specs.
 */

import type { MessagesScenario } from "../mocks/anthropic/server"

function baseUrl(): string {
  const url = process.env.E2E_ANTHROPIC_BASE_URL
  if (!url) {
    throw new Error(
      "E2E_ANTHROPIC_BASE_URL not set — global-setup must boot the mock Anthropic server " +
        "(don't run with PLAYWRIGHT_NO_GLOBAL_SETUP=1 for chat specs)."
    )
  }
  return url
}

export async function setAnthropicScenario(scenario: MessagesScenario): Promise<void> {
  const res = await fetch(`${baseUrl()}/__control/messages-scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scenario),
  })
  if (!res.ok) throw new Error(`setAnthropicScenario failed: HTTP ${res.status}`)
}

export async function resetAnthropic(): Promise<void> {
  const res = await fetch(`${baseUrl()}/__control/reset`, { method: "POST" })
  if (!res.ok) throw new Error(`resetAnthropic failed: HTTP ${res.status}`)
}
