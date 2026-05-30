/**
 * Dexie row shapes for the VS Code extension marketplace cache + runtime
 * telemetry tables (`openVsxCache` v31, `vscodeExtensionRuntime`).
 *
 * These are cognia-side persistence rows (distinct from the VS Code
 * `package.json` pass-through types in `./plugin-vscode.ts`). They live under
 * `types/plugin/` with the rest of the VS Code extension domain; `lib/db/schema.ts`
 * imports + re-exports them so `@/lib/db/schema` import sites keep working.
 * See `lib/db/CONVENTIONS.md`.
 */

/**
 * Open VSX marketplace metadata cache entry (v31, 24h TTL).
 * Keyed by canonical `publisher.name` identifier.
 */
export interface OpenVsxCacheRow {
  /** Canonical identifier — e.g. `"esbenp.prettier-vscode"`. */
  extensionId: string
  /** Epoch milliseconds when this entry was written. Stale after 24h. */
  fetchedAt: number
  /** Display name from the Open VSX response. */
  displayName: string
  /** Latest available version on Open VSX. */
  latestVersion: string
  /** Marketplace icon URL (CDN-backed). */
  iconUrl?: string
  /** Tags / categories from Open VSX, for filtered browse. */
  categories: string[]
  /** Download count, for sort-by-popular. */
  downloadCount: number
  /** Star rating, for sort-by-rating. */
  averageRating?: number
  /** Whether Open VSX has verified the publisher. */
  verified: boolean
  /**
   * Raw response payload (JSON-serialised) so the UI can render details
   * without a second round trip. Kept compact; full README / changelog
   * are fetched on-demand.
   */
  payload: unknown
}

/**
 * Per-extension runtime telemetry written by the VS Code sidecar.
 * Used by the Plugins → Extensions → VS Code surface to surface
 * "Last activated", "Last error", "Sidecar process id".
 */
export interface VscodeExtensionRuntimeRow {
  /** Canonical `publisher.name`. */
  extensionId: string
  /** Epoch ms of the most recent successful activate(). */
  lastActivatedAt: number | null
  /** Last sidecar-reported error message, or null if no error since last reset. */
  lastError: string | null
  /** PID of the Node sidecar hosting this extension when active; 0 when not running. */
  sidecarPid: number
  /** Sum of permission grants prompted during this extension's lifetime. */
  runtimePermissionGrants: number
  /** Sum of permission denials prompted during this extension's lifetime. */
  runtimePermissionDenials: number
}
