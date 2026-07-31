/**
 * ADR-0028 — per-session Computer Use sandbox confinement (renderer state).
 *
 * When a session has the sandbox enabled AND Computer Use enabled,
 * `resolveSendOptions` stashes a `SandboxConfine` here keyed by session id;
 * the computer-use plugin's `execute()` callback reads it back via
 * `getActiveSandboxConfine` to stamp `CallContext.sandboxConfine`, so the
 * native `bash` / `text_editor` tools run OS-sandboxed / path-confined instead
 * of unconfined. Mirrors `computer-use-target-state`. Cleared when the sandbox
 * (or Computer Use) is disabled for the session.
 */

export interface SandboxConfine {
  /** Writable roots. Empty → the Rust side defaults to the user's home dir. */
  writable?: string[]
  /** Extra read-only roots beyond the standard system paths. */
  readable?: string[]
  /** Network ceiling for the confined shell. Default `"off"`. */
  network?: "off" | "on" | "allowlist"
  /** Hosts allowed when `network` is `"allowlist"`. */
  networkHosts?: string[]
}

const active = new Map<string, SandboxConfine>()

export function setActiveSandboxConfine(
  sessionId: string | undefined,
  confine: SandboxConfine | null
): void {
  if (!sessionId) return
  if (confine) {
    active.set(sessionId, confine)
  } else {
    active.delete(sessionId)
  }
}

export function getActiveSandboxConfine(sessionId: string | undefined): SandboxConfine | null {
  return (sessionId ? active.get(sessionId) : undefined) ?? null
}

export function clearActiveSandboxConfine(sessionId: string | undefined): void {
  if (sessionId) active.delete(sessionId)
}

/** Test-only — wipe the registry. */
export function __resetSandboxConfineStateForTesting(): void {
  active.clear()
}
