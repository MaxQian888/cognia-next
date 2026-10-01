/**
 * Cogset writes a mirrored client hands to its host (ADR-0209).
 *
 * A paired phone or a browser driving a host does not own the plugin runtime,
 * so it cannot reconcile anything itself. It queues the request through the
 * outbound queue; the host executes it (`lib/companion/desktop-write-source.ts`)
 * and the result reaches this client on the next sync of `pluginCogsetState`.
 */

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { PluginInstallOriginRecord } from "@/types/plugin/plugin-cogset"

/** Ask the host to switch to `cogsetId`. */
export async function queueCogsetActivation(cogsetId: string): Promise<void> {
  await enqueue({
    command: "plugin_cogset_activate",
    payload: { cogsetId },
    // Machine-readable for the same reason `plugin_set_enabled` is: the queue
    // UI localizes around it.
    label: `plugin_cogset_activate:${cogsetId}`,
  })
}

/**
 * Hand an install origin to the host. The install itself ran on the host (the
 * installers call host commands); only the knowledge of where it came from
 * lives on this side.
 */
export async function queueInstallOriginRecord(record: PluginInstallOriginRecord): Promise<void> {
  await enqueue({
    command: "plugin_install_origin_record",
    payload: { record },
    label: `plugin_install_origin_record:${record.pluginId}`,
  })
}
