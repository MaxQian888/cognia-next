/**
 * Host-provided runtime handles the plugin's UI components cannot reach
 * through `PluginModalProps`. The modal gets only `{ onClose, modalId,
 * args }`, so `activate()` publishes `ctx.shell` here for the "Check
 * environment" button and clears it on teardown. Mirrors the playwright-mcp
 * plugin's `runtime.ts` seam.
 */

import type { PluginShellAPI } from "@cognia/plugin-sdk"

let shell: PluginShellAPI | undefined

export function setPluginShell(next: PluginShellAPI | undefined): void {
  shell = next
}

export function getPluginShell(): PluginShellAPI | undefined {
  return shell
}
