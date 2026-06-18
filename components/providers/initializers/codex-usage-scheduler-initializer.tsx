"use client"

// Starts the background Codex usage-probe loop on app boot (desktop only).
//
// The scheduler reads the live `codexSubscriptionSettings` each tick (via
// `useSettingsStore.getState()`, so cadence/enabled changes take effect without
// a restart) and resolves the active Codex account id from the subscription
// vault. It self-gates on `probeEnabled`, so mounting unconditionally is safe —
// the loop is a no-op until the user opts in. Without an explicit initializer
// the scheduler would be built-but-dormant; this is the wiring that makes it
// reachable.

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { getActiveAccount } from "@/lib/subscription/core/transport"
import { startCodexUsageScheduler } from "@/lib/subscription/codex/scheduler"
import {
  DEFAULT_CODEX_SUBSCRIPTION_SETTINGS,
  type CodexSubscriptionSettings,
} from "@/types/subscription"
import { useSettingsStore } from "@/stores/settings/settings-store"

function resolveCodexSettings(
  app: { codexSubscriptionSettings?: CodexSubscriptionSettings } | null | undefined
): CodexSubscriptionSettings {
  return app?.codexSubscriptionSettings ?? DEFAULT_CODEX_SUBSCRIPTION_SETTINGS
}

export function CodexUsageSchedulerInitializer() {
  useEffect(() => {
    if (!isTauri()) return
    const handle = startCodexUsageScheduler(
      // Read fresh from the store each tick so cadence/enabled edits apply
      // without tearing down the loop.
      () => resolveCodexSettings(useSettingsStore.getState().settings),
      {
        getActiveAccountId: async () => {
          try {
            const active = await getActiveAccount("codex")
            return active.activeAccountId ?? null
          } catch {
            return null
          }
        },
      }
    )
    return () => handle.stop()
  }, [])

  return null
}

export default CodexUsageSchedulerInitializer
