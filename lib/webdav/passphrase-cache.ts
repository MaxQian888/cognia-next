// In-memory cache for the zero-knowledge WebDAV sync passphrase.
//
// The passphrase is NEVER persisted (not keyring, not disk) — it lives only
// for the current session, set once the user unlocks. Scheduled/unattended
// uploads therefore only fire after an in-session unlock; the executor records
// a "passphrase locked" failure rather than silently falling back to the
// device auto-key (which the other device could not decrypt).
//
// Module-level singleton: tests must call `clearSyncPassphrase()` in afterEach.

let cached: string | null = null

export function setSyncPassphrase(passphrase: string | null): void {
  cached = passphrase && passphrase.length > 0 ? passphrase : null
}

export function getSyncPassphrase(): string | null {
  return cached
}

export function hasSyncPassphrase(): boolean {
  return cached !== null
}

export function clearSyncPassphrase(): void {
  cached = null
}
