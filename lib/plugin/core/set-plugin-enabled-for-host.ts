/**
 * The one enable/disable entry point for every plugin surface, on every host.
 *
 * # The gap this closes
 *
 * `togglePluginEnabled` drives the LOCAL plugin manager, which is correct on a
 * host that owns its plugin runtime (desktop, and a standalone browser for the
 * runtimes a browser can run). It is wrong on a mirrored client: a paired phone
 * or a browser pointed at a `cognia-server` gets its `plugins` rows from
 * `sync_pull("plugins")` (`lib/sync/companion-sync.ts`), has no local runtime
 * for them, and has to ask the host to flip the flag.
 *
 * Three call sites had already worked that out separately and disagreed.
 *
 *   - The desktop panel called `togglePluginEnabled`, which is right on desktop
 *     and a no-op on a phone whose manager holds none of those plugins.
 *   - `components/mobile/discover/plugins-panel.tsx` wrote Dexie and enqueued,
 *     which is right on a phone.
 *   - `components/discover/discover-inspector.tsx` wrote Dexie and enqueued
 *     **unconditionally**, so on desktop it reintroduced the exact defect
 *     `toggle-plugin-enabled.ts` exists to prevent (a row that says "enabled"
 *     over a runtime that never started) and queued a job for a host that is
 *     itself.
 *
 * # Why the predicate is not `isTauri()` and not `useRemoteHostActive()`
 *
 * The question is "is this runtime's `plugins` table a MIRROR of some host's,
 * or the authority?", which is the same question
 * `lib/settings/mirror-to-host.ts` answers for `AppSettings`, so it gets the
 * same predicate. A desktop driving a remote host (ADR-0082) still runs its own
 * plugin manager against its own rows: `desktop-sync-source.ts` makes it a sync
 * SOURCE for `plugins`, never a sink. Routing its toggles to the queue would
 * send them to a host that does not own the plugin being toggled.
 *
 * An unpaired standalone phone also matches, which is harmless. The job waits
 * in the queue until a host exists, exactly as the outbound queue is designed
 * to behave.
 */

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

import { PLUGIN_ANALYTIC_KEYS, recordPluginAnalytic } from "@/lib/plugin/analytics/record"

import { togglePluginEnabled, type TogglePluginResult } from "./toggle-plugin-enabled"

export interface SetPluginEnabledResult extends TogglePluginResult {
  /**
   * True when the change was handed to the host through the outbound queue
   * rather than applied by the local manager. Callers that want to say
   * "queued, will apply when your desktop is online" branch on this.
   */
  queued: boolean
}

/**
 * True when this runtime's `plugins` rows mirror some host's rather than being
 * the authority. Exported so surfaces can label the affordance honestly, since
 * a queued toggle is not the same promise as an applied one.
 */
export function isMirroredPluginClient(): boolean {
  return isCapacitor() || hasWebCompanionTarget()
}

export async function setPluginEnabledForHost(
  pluginId: string,
  next: boolean,
  reason = "manual"
): Promise<SetPluginEnabledResult> {
  // Recorded here rather than at each caller: this is the one place every
  // enable/disable now passes through, and the analytics table had no writer
  // at all, which is why Governance's Analytics view could only ever be empty.
  void recordPluginAnalytic(
    pluginId,
    next ? PLUGIN_ANALYTIC_KEYS.enabled : PLUGIN_ANALYTIC_KEYS.disabled
  )

  if (!isMirroredPluginClient()) {
    const result = await togglePluginEnabled(pluginId, next, reason)
    return { ...result, queued: false }
  }

  try {
    // Optimistic local write first so the switch settles immediately. The row
    // is a mirror, so the host's next `sync_pull` is what makes it durable.
    await getDb().plugins.update(pluginId, { enabled: next, updatedAt: Date.now() })
    await enqueue({
      command: "plugin_set_enabled",
      payload: { id: pluginId, enabled: next },
      // Machine-readable, for the same reason `mirrorSettingsPatchToHost`
      // writes a key list: `MobileOutboundJobRow.label` has no renderer, and
      // this runs outside React where resolving a locale would mean pulling
      // the message bundle into a Dexie write. A queue UI localises around
      // this, it does not print it raw.
      label: `plugin_set_enabled:${pluginId}:${next ? "enabled" : "disabled"}`,
    })
    return { ok: true, queued: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, queued: true, error: message }
  }
}
