"use client"

import { useEffect, useSyncExternalStore } from "react"
import Dexie from "dexie"

import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { listPromptOverrideBindings } from "@/lib/db/prompt-overrides"
import {
  invalidatePromptOverrideSnapshot,
  loadPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { loggers } from "@cognia/logging"

const log = loggers.shell

/**
 * Keeps the Prompt Center override snapshot (ADR-0236) loaded for the active
 * account database.
 *
 * Keystroke-path consumers (composer ghost text, terminal completion) resolve
 * synchronously and only see an override once the snapshot is in memory, so
 * it is loaded at boot rather than on the first async consumer. Writes made in
 * this window already refresh it (`onPromptOverridesChanged`); the live query
 * covers the rest: another window, a backup restore, a reset from the CLI
 * bridge. Each emission drops the cached snapshot and reads it again, so a
 * consumer never resolves against a revision set that was replaced.
 *
 * Re-subscribes when the runtime target changes, the same trigger the project
 * store uses, because a different target means a different database.
 */
export function PromptOverridesInitializer() {
  const scopeKey = useSyncExternalStore(
    subscribeRuntimeTargetContext,
    getRuntimeTargetScopeKey,
    getRuntimeTargetScopeKey
  )

  useEffect(() => {
    let cancelled = false
    let primed = false
    // `Dexie.liveQuery`, not the named `liveQuery` export: the latter is
    // undefined under Jest's module interop.
    const subscription = Dexie.liveQuery(() => listPromptOverrideBindings()).subscribe({
      next: () => {
        if (cancelled) return
        // The first emission is the initial read; a snapshot another caller
        // already loaded for this database is still current.
        if (primed) invalidatePromptOverrideSnapshot()
        primed = true
        void loadPromptOverrideSnapshot().catch((err: unknown) =>
          log.warn("prompt-overrides: snapshot load failed", { err })
        )
      },
      error: (err: unknown) => log.warn("prompt-overrides: live query failed", { err }),
    })
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [scopeKey])

  return null
}

export default PromptOverridesInitializer
