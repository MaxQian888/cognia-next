"use client"

/**
 * Host-key change detection and re-trust.
 *
 * TOFU fails closed: once a server's key is learned, a different key aborts the
 * connection. That is the correct default and the reason the feature is worth
 * anything — but "connection failed" is useless to the user, who is the only
 * one who can tell a re-provisioned server from a machine-in-the-middle. The
 * native side therefore reports the mismatch as `ssh_host_key_changed:<json>`
 * (see `crates/cognia-terminal/src/ssh.rs`), which this module decodes so the
 * UI can show both fingerprints and offer a deliberate re-trust.
 *
 * Re-trusting is local-only by construction: `ssh_forget_host_key` is a Tauri
 * command on the main webview, and remote or mobile clients reach the terminal
 * through the host socket instead (ADR-0082 §8.3).
 */

import { transport } from "@/lib/tauri"

/** Must match `HOST_KEY_CHANGED_CODE` in `crates/cognia-terminal/src/ssh.rs`. */
export const HOST_KEY_CHANGED_CODE = "ssh_host_key_changed"

export interface SshHostKeyChange {
  host: string
  port: number
  /**
   * Fingerprint recorded on first connect. `null` when the stored entry could
   * not be read back — a hand-edited or truncated `known_hosts`. The warning
   * still stands; only the "was" half is missing.
   */
  knownFingerprint: string | null
  presentedFingerprint: string
}

function isHostKeyChange(value: unknown): value is SshHostKeyChange {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.host === "string" &&
    v.host.length > 0 &&
    typeof v.port === "number" &&
    Number.isInteger(v.port) &&
    typeof v.presentedFingerprint === "string" &&
    v.presentedFingerprint.length > 0 &&
    (v.knownFingerprint === null ||
      v.knownFingerprint === undefined ||
      typeof v.knownFingerprint === "string")
  )
}

/**
 * Decode a spawn failure into a host-key change, or `null` for every other
 * error.
 *
 * Tolerant on purpose: a malformed payload degrades to `null` so the caller
 * shows its ordinary connection-failed path rather than a half-rendered
 * security warning with blank fingerprints.
 */
export function parseHostKeyChange(message: unknown): SshHostKeyChange | null {
  if (typeof message !== "string") return null
  const marker = `${HOST_KEY_CHANGED_CODE}:`
  const start = message.indexOf(marker)
  if (start < 0) return null
  const payload = message.slice(start + marker.length).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isHostKeyChange(parsed)) return null
  return {
    host: parsed.host,
    port: parsed.port,
    knownFingerprint: parsed.knownFingerprint ?? null,
    presentedFingerprint: parsed.presentedFingerprint,
  }
}

/**
 * Drop the trusted key for `host:port` so the next connection re-learns it.
 *
 * Returns how many `known_hosts` entries were removed; `0` means there was
 * nothing recorded, which is not an error.
 */
export async function forgetSshHostKey(host: string, port: number): Promise<number> {
  return transport.call<number>("ssh_forget_host_key", { host, port })
}
