/**
 * In-memory audit ring buffer for file operations.
 *
 * Mirrors `lib/logging/recent-errors.ts`: a bounded, newest-first list with a
 * subscribe hook so a diagnostics surface can render the recent file-IO trail
 * without reaching into the logging transports. The secure file-IO façade
 * (`lib/files/secure-fs.ts`) records one entry per attempted operation —
 * allowed or denied — alongside the structured log line.
 */

import { nanoid } from "nanoid"
import type { FileAuditEntry } from "@/types/files"

const MAX_AUDIT_ENTRIES = 200

let entries: FileAuditEntry[] = []
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber()
  }
}

/**
 * Build a `FileAuditEntry` from the operation details, filling the `id` and
 * `ts`. Callers pass everything except those two so id/ts generation stays in
 * one place.
 */
export function createFileAuditEntry(input: Omit<FileAuditEntry, "id" | "ts">): FileAuditEntry {
  return { id: `fa-${nanoid()}`, ts: Date.now(), ...input }
}

/** Push an entry to the front of the buffer (de-duped by id) and notify. */
export function recordFileAudit(entry: FileAuditEntry): void {
  entries = [entry, ...entries.filter((current) => current.id !== entry.id)].slice(
    0,
    MAX_AUDIT_ENTRIES
  )
  notifySubscribers()
}

/** The most recent entries, newest first, capped at `limit`. */
export function getFileAudit(limit = MAX_AUDIT_ENTRIES): FileAuditEntry[] {
  return entries.slice(0, limit)
}

/** Drop every recorded entry and notify. */
export function clearFileAudit(): void {
  entries = []
  notifySubscribers()
}

/** Subscribe to buffer changes; returns an unsubscribe function. */
export function subscribeFileAudit(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

/** Test helper — reset both the buffer and the subscriber set. */
export function resetFileAuditForTest(): void {
  entries = []
  subscribers.clear()
}
