"use client"

// Renderer-side migration coordinator.
//
// Called once on app boot from `app/layout.tsx` (via `SubscriptionInitializer`).
// Steps:
//   0. Bail out when there is no host to migrate against. Plain browser mode
//      with no paired/configured cognia-server has no keyring at all, so
//      `subscription_init` can only reject with the WebStubTransport's
//      "tauri-only command from web mode" error — noisy, and never actionable.
//   1. Invoke `subscription_init` on the Rust side. Returns one outcome per
//      provider. Rust handles all keyring I/O — silent on the renderer side.
//   2. If any provider was actually `Migrated`, fire a single Sonner toast
//      summarising the count. The toast is keyed by `localStorage` so it
//      shows AT MOST ONCE for the lifetime of this user's profile on this
//      browser/desktop install, no matter how many app boots happen after.
//   3. Surface the outcome to callers (rare — only the dev tools panel reads
//      it today; the toast is the primary UX channel).
//
// Failures are swallowed at the toast layer (we log a console warn) — a
// migration failure should never block app boot.

import { toast } from "sonner"

import { isTauri } from "@/lib/platform/detect"
import type { MigrationOutcome } from "@/types/subscription"
import { subscriptionInit } from "./transport"

const TOAST_FLAG_KEY = "subscription.migrationToastShown"

export interface SubscriptionInitResult {
  outcomes: MigrationOutcome[]
  migratedCount: number
  toastShown: boolean
  error?: string
  /**
   * True when no host backend was reachable, so nothing was invoked. Distinct
   * from `error` — this is the expected steady state of plain web mode, not a
   * failure.
   */
  skipped?: boolean
}

/**
 * Whether this renderer has the local IPC transport that owns subscription
 * migration. `subscription_init` is a `target: "client"` command, so a web or
 * Capacitor companion cannot delegate it to a paired Host even when that Host
 * runs other execution-plane work on the client's behalf.
 */
function hasSubscriptionHost(): boolean {
  return isTauri()
}

/**
 * Bootstrap entry point. Idempotent — multiple calls in the same tab are
 * deduped through React `useEffect` and the toast flag.
 *
 * @param options.translateToast — i18n-aware label resolver. Pass the
 *   `next-intl` `t` function bound to the `subscription.migration` namespace;
 *   the migrator pulls `toastTitle` + `toastBody({count})` keys. When unset,
 *   we fall back to a tiny English default so unit tests (and unusual
 *   bootstrap paths) keep working.
 * @param options.storage — localStorage adapter (real `window.localStorage`
 *   in production, in-memory mock in tests).
 */
export async function subscriptionInitOnce(
  options: {
    translateToast?: (key: string, params?: Record<string, unknown>) => string
    storage?: Pick<Storage, "getItem" | "setItem">
  } = {}
): Promise<SubscriptionInitResult> {
  const storage = options.storage ?? defaultStorage()

  // Web mode with no backend: there is no keyring to migrate. Skip silently.
  if (!hasSubscriptionHost()) {
    return { outcomes: [], migratedCount: 0, toastShown: false, skipped: true }
  }

  let outcomes: MigrationOutcome[]
  try {
    outcomes = await subscriptionInit()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("subscription_init failed:", message)
    return {
      outcomes: [],
      migratedCount: 0,
      toastShown: false,
      error: message,
    }
  }

  const migratedCount = outcomes.filter((o) => o.kind === "migrated").length
  if (migratedCount === 0) {
    return { outcomes, migratedCount: 0, toastShown: false }
  }

  // Already shown for this profile?
  const alreadyShown = storage?.getItem?.(TOAST_FLAG_KEY) === "1"
  if (alreadyShown) {
    return { outcomes, migratedCount, toastShown: false }
  }

  try {
    const title = options.translateToast?.("toastTitle") ?? "Subscription module upgraded"
    const body =
      options.translateToast?.("toastBody", { count: migratedCount }) ??
      `Migrated ${migratedCount} legacy account${migratedCount === 1 ? "" : "s"} into the new vault.`
    toast.success(title, { description: body })
  } catch (err) {
    // sonner not available in some test environments — log and continue.
    console.warn("subscription migration toast failed:", err)
    return { outcomes, migratedCount, toastShown: false }
  }

  try {
    storage?.setItem?.(TOAST_FLAG_KEY, "1")
  } catch {
    // Ignore quota / SecurityError — at worst the toast shows again next boot.
  }

  return { outcomes, migratedCount, toastShown: true }
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  if (typeof window === "undefined") return undefined
  try {
    return window.localStorage
  } catch {
    // Private browsing or SSR — caller can pass an in-memory shim.
    return undefined
  }
}

/** Reset the once-per-profile flag. Test-only. */
export function _resetMigrationToastFlag(storage?: Pick<Storage, "removeItem">): void {
  const target =
    storage ??
    (typeof window !== "undefined"
      ? (window.localStorage as Pick<Storage, "removeItem">)
      : undefined)
  try {
    target?.removeItem?.(TOAST_FLAG_KEY)
  } catch {
    // Ignore SecurityError / QuotaExceededError — at worst the toast fires
    // again next boot, which is acceptable in test environments.
  }
}
