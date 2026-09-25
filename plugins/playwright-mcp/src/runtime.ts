/**
 * Host handles the setup modal needs but cannot reach through
 * `PluginModalProps` (`{ onClose, modalId, args }`): the allowlisted shell for
 * "Check environment" and in-app navigation for "Set up in Settings".
 * `activate()` publishes them from `ctx` and clears them through the
 * generation lifecycle, so a re-activation can never leave a stale API behind.
 */

import type { PluginShellAPI, PluginUIAPI } from "@cognia/plugin-sdk"

export interface SetupModalHost {
  shell: Pick<PluginShellAPI, "execute">
  navigate: PluginUIAPI["navigate"]
}

let host: SetupModalHost | undefined

export function setSetupModalHost(next: SetupModalHost | undefined): void {
  host = next
}

export function getSetupModalHost(): SetupModalHost | undefined {
  return host
}
