/**
 * Per-set dismiss bookkeeping shared by the Inbox notice sources.
 *
 * "Per-set" is the whole point: dismissing a notice hides *that* set of
 * failing adapters, not the notice forever. If the set changes — one heals,
 * another drops — the hash no longer matches and the notice comes back with
 * the new content.
 *
 * Extracted from `connection-loss-banner.tsx` and `outbound-saturation-banner.tsx`,
 * which carried byte-identical copies of this logic apart from the storage
 * they wrote to. That difference is deliberate and preserved by making the
 * `Storage` a caller argument:
 *   - connection loss → `localStorage`, so a reload doesn't rebroadcast a
 *     failure set the operator already acknowledged;
 *   - outbound saturation → `sessionStorage`, because the failing set is
 *     short-lived and should reset on its own.
 *
 * Reads are synchronous (not Dexie) because the first render decides whether
 * to mount, and the value is single-user/single-device by design.
 */

/** How long a dismissal holds before the notice is allowed back. */
export const DISMISS_TTL_MS = 30 * 60 * 1000

export interface PersistedDismiss {
  hash: string
  at: number
}

/**
 * Stable hash of an affected-id set, so dismissals compare equal regardless of
 * the order Dexie happened to return the rows in.
 */
export function hashSet(ids: readonly string[]): string {
  return ids.slice().sort().join("|")
}

/**
 * Resolves the backing store, or `null` under SSR (the static export
 * pre-renders these components). Rejected *writes* — Safari private mode,
 * a full quota — are handled per-operation below, so this stays a plain
 * lookup.
 */
export function safeStorage(kind: "local" | "session"): Storage | null {
  if (typeof window === "undefined") return null
  return kind === "local" ? window.localStorage : window.sessionStorage
}

export function readDismiss(key: string, storage: Storage | null): PersistedDismiss | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedDismiss>
    if (typeof parsed.hash !== "string" || typeof parsed.at !== "number") return null
    return { hash: parsed.hash, at: parsed.at }
  } catch {
    return null
  }
}

export function writeDismiss(key: string, hash: string, storage: Storage | null): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify({ hash, at: Date.now() } satisfies PersistedDismiss))
  } catch {
    // Best-effort — a full or read-only quota must not break the notice.
  }
}

export function clearDismiss(key: string, storage: Storage | null): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Best-effort.
  }
}

/** Milliseconds until `snapshot` expires; `0` once it already has. */
export function msUntilDismissExpiry(snapshot: PersistedDismiss, now = Date.now()): number {
  return Math.max(0, snapshot.at + DISMISS_TTL_MS - now)
}
