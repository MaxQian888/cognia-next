/**
 * Web-standalone → cloud-companion detection (ADR-0059 C1).
 *
 * A plain browser build becomes a *cloud companion* when it has a
 * cognia-server to talk to. Two ways to have one:
 *
 * 1. **Build-time**: `NEXT_PUBLIC_COGNIA_SERVER_URL` — the self-host operator
 *    bakes their server URL into the web bundle (compose/k8s deployments
 *    serve the static export next to the server).
 * 2. **Runtime**: the user already paired in this browser — a public host
 *    record sits in localStorage while its P-256 private key stays encrypted
 *    in the Browser Vault.
 *
 * Pure leaf, synchronous on purpose: `pickTransport()` runs at module load,
 * so this must not await the async storage facade, and it must not drag the
 * credential book's Dexie/Vault dependencies into that path. The storage keys
 * below are therefore mirrored rather than imported, and a test asserts they
 * stay identical to the ones their owners write.
 */

import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

// Mirrors CONFIG_KEY in lib/tauri/companion-storage.ts (asserted by test).
export const WEB_COMPANION_CONFIG_KEY = "cognia.companion.config.v1"
// Mirrors CONFIG_BOOK_KEY in lib/tauri/companion-storage.ts (asserted by test).
export const WEB_COMPANION_TARGET_BOOK_KEY = "cognia.companion.targets.v2"
// Mirrors HOST_BOOK_KEY in lib/companion/credential-book/stores.ts (asserted
// by test). THIS is where a pairing made by the current code actually lands:
// `MigratingCompanionStorage.save()` writes the credential book and then
// clears the legacy target book above, so reading only the legacy key made
// every web pairing look absent on the next page load.
export const WEB_COMPANION_HOST_BOOK_KEY = "cognia.companion.hosts.v2"

/** Build-time server URL, normalized (no trailing slash); null when unset. */
export function buildTimeServerUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_COGNIA_SERVER_URL
  if (!url || url.trim() === "") return null
  return url.trim().replace(/\/+$/, "")
}

/** The active runtime target id, when one has been activated. */
function activeTargetId(): string | null {
  return getActiveRuntimeTargetContext()?.targetId ?? null
}

/**
 * A public host record proves a device identity was registered: the private
 * half lives in the Vault, but `deviceKeyThumbprint` is only ever written
 * alongside a successful registration.
 */
function isPairedHostRecord(value: unknown): value is { hostId: string } {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.hostId === "string" &&
    record.hostId.length > 0 &&
    typeof record.deviceKeyThumbprint === "string" &&
    record.deviceKeyThumbprint.length > 0
  )
}

/**
 * Canonical check — the credential book's public record store.
 *
 * With a runtime target active the lookup is scoped to it, so a browser
 * sitting on its **standalone** target is not mistaken for a paired one just
 * because some other target in the same account is paired. Before any target
 * has been activated (module load, pre-unlock) any complete record counts;
 * the boot provider re-resolves against the real scope once it mounts.
 */
function hostBookHasPairing(targetId: string | null): boolean {
  const raw = window.localStorage.getItem(WEB_COMPANION_HOST_BOOK_KEY)
  if (!raw) return false
  const parsed = JSON.parse(raw) as { version?: unknown; hosts?: unknown }
  if (parsed.version !== 2 || !parsed.hosts || typeof parsed.hosts !== "object") return false
  const records = Object.values(parsed.hosts as Record<string, unknown>).filter(isPairedHostRecord)
  // Match on `hostId` rather than the composed storage key: the runtime target
  // id IS the host id (`host-orchestration.ts:runtimeTargetInput`), and this
  // sidesteps any account-namespace drift between the record and the scope.
  if (targetId) return records.some((record) => record.hostId === targetId)
  return records.length > 0
}

/** Legacy pre-credential-book target book. Read only until it migrates away. */
function legacyTargetBookHasPairing(targetId: string | null): boolean {
  const raw = window.localStorage.getItem(WEB_COMPANION_TARGET_BOOK_KEY)
  if (!raw) return false
  const parsed = JSON.parse(raw) as { version?: unknown; targets?: unknown }
  if (parsed.version !== 2 || !parsed.targets || typeof parsed.targets !== "object") return false
  const targets = parsed.targets as Record<string, unknown>
  const scope = getActiveRuntimeTargetContext()
  if (scope && targetId) return Boolean(targets[`${scope.accountId}:${targetId}`])
  return Object.keys(targets).length > 0
}

/** Whether a canonical cgnp3 pairing exists in this browser. */
export function hasStoredWebPairing(): boolean {
  if (typeof window === "undefined") return false
  try {
    const targetId = activeTargetId()
    if (hostBookHasPairing(targetId)) return true
    if (legacyTargetBookHasPairing(targetId)) return true

    // The former single-record bearer credential is intentionally ignored;
    // this breaking upgrade requires a fresh device-key pairing.
    window.localStorage.removeItem(WEB_COMPANION_CONFIG_KEY)
    return false
  } catch {
    return false
  }
}

/**
 * Whether this web build should run the companion transport instead of the
 * stub. True in a plain browser (NOT Tauri/Capacitor — callers gate on that)
 * with either a configured server or an existing pairing.
 */
export function hasWebCompanionTarget(): boolean {
  return buildTimeServerUrl() !== null || hasStoredWebPairing()
}
