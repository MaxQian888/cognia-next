/**
 * The one fire site of the `onExternalAgentConfigChange` hook (ADR-0216).
 *
 * Every external-agent mutation — Settings, the phone, the CLI, a plugin
 * through `ctx.externalAgents`, startup reconciliation — ends in the
 * external-agent store, so the store is where the hook is fired from rather
 * than from each writer: a writer that forgot to fire would make the hook lie
 * by omission. The diff is the same one `ctx.externalAgents.onChange` uses, so
 * a Python plugin and a TypeScript plugin observe the same events.
 *
 * Installed once per plugin runtime by `PluginRuntimeInitializer`, which also
 * disposes it when the runtime is torn down. Delivery is permission-gated in
 * the dispatcher (`HOOK_POINT_PERMISSIONS` → `agent:external:read`).
 */

import { loggers } from "@cognia/logging"
import { subscribeExternalAgentChanges } from "@/lib/plugin/api/external-agents-changes"
import { getPluginEventHooks } from "./hooks-system"

const log = loggers.plugin

let installed: { dispose: () => void; refs: number } | null = null

/**
 * Start forwarding store changes to the hook. Returns a disposer.
 *
 * Reference-counted so a remount (React StrictMode runs effects twice) neither
 * fires every event twice nor tears the feed down under a live runtime.
 */
export function installExternalAgentConfigHookSource(): () => void {
  if (installed) {
    installed.refs += 1
  } else {
    const dispose = subscribeExternalAgentChanges(
      (event) => {
        void getPluginEventHooks()
          .dispatchExternalAgentConfigChange(event)
          .catch((error: unknown) =>
            log.warn("external-agent config hook dispatch failed", {
              type: event.type,
              error: error instanceof Error ? error.message : String(error),
            })
          )
      },
      (error) =>
        log.warn("external-agent config change feed failed", {
          error: error instanceof Error ? error.message : String(error),
        })
    )
    installed = { dispose, refs: 1 }
  }

  let released = false
  return () => {
    if (released || !installed) return
    released = true
    installed.refs -= 1
    if (installed.refs === 0) {
      installed.dispose()
      installed = null
    }
  }
}

/** Test seam: drop the shared subscription regardless of references. */
export function __resetExternalAgentConfigHookSourceForTesting(): void {
  installed?.dispose()
  installed = null
}
