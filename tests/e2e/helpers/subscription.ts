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

export async function listAccountsForProvider(
  page: Page,
  provider: "anthropic" | "codex" | "opencode"
): Promise<Array<{ id: string; label: string | null }>> {
  return await page.evaluate(async (p) => {
    const { listAccounts } = await import("@/lib/subscription/core/transport")
    const summaries = await listAccounts(p)
    return summaries.map((s: { id: string; label: string | null }) => ({
      id: s.id,
      label: s.label,
    }))
  }, provider)
}

export async function getActiveAccountId(
  page: Page,
  provider: "anthropic" | "codex" | "opencode"
): Promise<string | null> {
  return await page.evaluate(async (p) => {
    const { getActiveAccount } = await import("@/lib/subscription/core/transport")
    const snap = await getActiveAccount(p)
    return snap?.accountId ?? null
  }, provider)
}

/**
 * Seed an Anthropic account directly via `subscription_save_account`. Used
 * by switch/preset specs that need ≥1 account preloaded without driving the
 * full OAuth dialog flow. Returns the seeded account id.
 */
export async function seedAnthropicAccount(
  page: Page,
  opts: {
    email: string
    label?: string
    mode?: "subscription" | "console"
    plan?: string
  }
): Promise<string> {
  return await page.evaluate(async (o) => {
    const { saveAccount } = await import("@/lib/subscription/core/transport")
    const { uuidv7 } = await import("@/lib/subscription/core/uuidv7")
    const now = Date.now()
    const id = uuidv7(now)
    const account = {
      id,
      label: o.label,
      credential: {
        provider: "anthropic" as const,
        accessToken: `seeded-at-${id}`,
        refreshToken: `seeded-rt-${id}`,
        expiresAtMs: now + 8 * 3600 * 1000,
        mode: o.mode ?? "subscription",
        email: o.email,
        plan: o.plan ?? "claude_pro",
        storedAtMs: now,
      },
      createdAtMs: now,
      lastUsedAtMs: now,
    }
    await saveAccount("anthropic", account)
    return id
  }, opts)
}

export async function setActiveAccountId(
  page: Page,
  provider: "anthropic" | "codex" | "opencode",
  accountId: string | null
): Promise<void> {
  await page.evaluate(
    async (input) => {
      const { setActiveAccount } = await import("@/lib/subscription/core/transport")
      await setActiveAccount(input.provider, input.accountId)
    },
    { provider, accountId }
  )
}

export async function readProviderPreset(
  page: Page,
  provider: "anthropic" | "codex"
): Promise<{ id: string; label: string; baseUrl: string } | null> {
  return await page.evaluate(async (p) => {
    const { getProviderPreset } = await import("@/lib/subscription/core/transport")
    const preset = await getProviderPreset(p)
    if (!preset) return null
    return { id: preset.id, label: preset.label, baseUrl: preset.baseUrl }
  }, provider)
}
