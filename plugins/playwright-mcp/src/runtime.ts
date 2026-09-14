/**
 * Host-provided runtime handles the plugin's UI components cannot reach
 * through `PluginModalProps`. The modal gets only `{ onClose, modalId,
 * args }`, so `activate()` publishes `ctx.shell` here for the "Check
 * environment" button and clears it on teardown. Mirrors the zhihu plugin's
 * `db/runtime.ts` seam.
 */

import type { PluginShellAPI } from "@cognia/plugin-sdk"

let shell: PluginShellAPI | undefined

export function setPluginShell(next: PluginShellAPI | undefined): void {
  shell = next
}

export function getPluginShell(): PluginShellAPI | undefined {
  return shell
}
