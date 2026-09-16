/**
 * A synchronous settings read for code that re-checks a switch while a call is
 * in flight (ADR-0188 AUTH-07, B2).
 *
 * On the desktop window the settings store is loaded and live, so a user who
 * switches a surface off mid-call is seen by the next re-check. A headless
 * brain never loads that store (only `SettingsHydrator`, a React provider,
 * does), so there the re-check falls back to the snapshot the request read
 * when it started — the brain cannot observe a toggle during one request, and
 * reading the empty store instead would refuse every call as "switched off".
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings/settings-store"

export function liveSettingsReader(
  snapshot: AppSettings | null | undefined
): () => AppSettings | undefined {
  return () => {
    const state = useSettingsStore.getState()
    return (state.loaded ? state.settings : snapshot) ?? undefined
  }
}
