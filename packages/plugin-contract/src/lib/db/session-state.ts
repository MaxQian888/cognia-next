/**
 * The plugin contract's share of `lib/db/session-state.ts`, which re-exports these.
 */
/**
 * Per-session unread tracking. Only sessions the user has actually opened
 * have a row here; everything else is treated as unread = 0.
 *
 * Co-located with this CRUD module; `schema.ts` imports + re-exports it, so
 * existing `@/lib/db/schema` import sites keep working. See `CONVENTIONS.md`.
 */
export interface SessionStateRow {
  sessionId: string
  lastReadAt: number
  unreadCount: number
  /**
   * Sync watermark. Non-indexed, so it needs no Dexie version bump.
   *
   * `lastReadAt` cannot serve as the cursor: `bumpUnread` deliberately
   * preserves it, so the one event a paired device most needs to hear about,
   * a conversation going unread, would never advance the watermark and would
   * never cross the wire. Both writers stamp this instead. Legacy rows have no
   * `updatedAt`, so the reader falls back to `lastReadAt` and they cross once.
   */
  updatedAt?: number
  /**
   * Set only by an explicit "mark unread" ({@link markSessionUnreadOnHost}):
   * `at` is the watermark that write stamped, `from` the watermark it was taken
   * over. Every other writer replaces the row without it, so it is live only
   * while the manual unread is still the latest change — which is exactly when
   * a device read covering `from` may clear it. Non-indexed, no version bump.
   */
  manualUnread?: { at: number; from: number }
}
