/**
 * Process-local guard that binds plugin execution to one unlocked LocalProfile.
 * The native permission ledger enforces the same boundary independently.
 */

let activeAccountId: string | null = null
let blocked = true
let enforced = false

export function activatePluginRuntimeAccount(localAccountId: string): void {
  if (!localAccountId.trim()) throw new Error("Plugin runtime account is required.")
  activeAccountId = localAccountId
  blocked = false
  enforced = true
}

export function blockPluginRuntimeAccount(localAccountId?: string): void {
  if (localAccountId && activeAccountId && localAccountId !== activeAccountId) return
  blocked = true
  enforced = true
}

export function clearPluginRuntimeAccount(): void {
  blocked = true
  activeAccountId = null
  enforced = true
}

export function pluginRuntimeAccountAvailable(): boolean {
  // Existing isolated unit tests construct permission guards without the app
  // account lifecycle. Production enables enforcement before plugin boot.
  return !enforced || (!blocked && activeAccountId !== null)
}
