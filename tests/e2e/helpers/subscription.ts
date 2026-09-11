/**
 * Helpers for the `tests/e2e/tauri/subscription/*.spec.ts` family. Provide a
 * uniform reset path that wipes every provider's keyring vault between tests
 * and exposes the captured `openUrl` calls so specs can assert the OAuth
 * authorize URL was assembled correctly without popping a real browser.
 *
 * The reset relies on the dev-only bridge installed by
 * `lib/dev/expose-test-globals.tsx`. The Tauri shell must have been booted
 * with `NEXT_PUBLIC_E2E=1` for the bridge to mount.
 */

import { expect, type Page } from "@playwright/test"
import { uuidv7 } from "@/lib/subscription/core/uuidv7"
import { waitForTestGlobals } from "./db-reset"

export async function resetSubscriptionState(page: Page): Promise<void> {
  await waitForTestGlobals(page)
  const ok = await page.evaluate(async () => {
    const w = window as Window & {
      __cogniaResetSubscriptionState?: () => Promise<void>
    }
    if (typeof w.__cogniaResetSubscriptionState !== "function") return false
    await w.__cogniaResetSubscriptionState()
    return true
  })
  expect(ok, "window.__cogniaResetSubscriptionState should be callable").toBe(true)
}

export async function clearOpenUrlCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Window & { __cogniaE2EOpenUrlCalls?: string[] }
    if (Array.isArray(w.__cogniaE2EOpenUrlCalls)) w.__cogniaE2EOpenUrlCalls.length = 0
  })
}

export async function readOpenUrlCalls(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as Window & { __cogniaE2EOpenUrlCalls?: string[] }
    return Array.isArray(w.__cogniaE2EOpenUrlCalls) ? [...w.__cogniaE2EOpenUrlCalls] : []
  })
}

/** Use the existing bundled transport bridge; browser evaluate cannot resolve TS aliases. */
async function subscriptionCommand<T>(
  page: Page,
  command: string,
  params: Record<string, unknown>
): Promise<T> {
  await waitForTestGlobals(page)
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const bridge = window.__cogniaE2ECompanion
          return (await bridge?.runtime())?.accountId ?? null
        }),
      { message: "Subscription IPC needs an unlocked local account" }
    )
    .not.toBeNull()
  return await page.evaluate(
    async ({ method, args }) => {
      const bridge = window.__cogniaE2ECompanion
      const runtime = await bridge?.runtime()
      if (!bridge || !runtime) throw new Error("Subscription transport bridge is not ready")
      return (await bridge.call(method, { ...args, localAccountId: runtime.accountId })) as T
    },
    { method: command, args: params }
  )
}

export async function listAccountsForProvider(
  page: Page,
  provider: "anthropic" | "codex" | "opencode"
): Promise<Array<{ id: string; label: string | null }>> {
  return await subscriptionCommand(page, "subscription_list_accounts", { provider })
}

export async function getActiveAccountId(
  page: Page,
  provider: "anthropic" | "codex" | "opencode"
): Promise<string | null> {
  const snap = await subscriptionCommand<{ activeAccountId: string | null }>(
    page,
    "subscription_get_active",
    { provider }
  )
  return snap.activeAccountId ?? null
}

/** Seed synthetic credentials before navigation; the next mount reloads the native vault. */
export async function seedAnthropicAccount(
  page: Page,
  opts: {
    email: string
    label?: string
    mode?: "subscription" | "console"
    plan?: string
  }
): Promise<string> {
  const now = Date.now()
  const id = uuidv7(now)
  await subscriptionCommand(page, "subscription_save_account", {
    provider: "anthropic",
    account: {
      id,
      label: opts.label,
      credential: {
        provider: "anthropic",
        accessToken: `seeded-at-${id}`,
        refreshToken: `seeded-rt-${id}`,
        expiresAtMs: now + 8 * 3600 * 1000,
        mode: opts.mode ?? "subscription",
        email: opts.email,
        plan: opts.plan ?? "claude_pro",
        storedAtMs: now,
      },
      createdAtMs: now,
      lastUsedAtMs: now,
    },
  })
  return id
}

export async function setActiveAccountId(
  page: Page,
  provider: "anthropic" | "codex" | "opencode",
  accountId: string | null
): Promise<void> {
  await subscriptionCommand(page, "subscription_set_active", { provider, accountId })
}

export async function readProviderPreset(
  page: Page,
  provider: "anthropic" | "codex"
): Promise<{ id: string; label: string; baseUrl: string } | null> {
  return await subscriptionCommand(page, "subscription_get_preset", { provider })
}

/** Safe detail projection verifies binding without reading credential bytes. */
export async function readAccountPresetId(
  page: Page,
  provider: "anthropic" | "codex" | "opencode",
  accountId: string
): Promise<string | null> {
  const detail = await subscriptionCommand<{ presetId?: string } | null>(
    page,
    "subscription_get_account_detail",
    { provider, accountId }
  )
  return detail?.presetId ?? null
}
