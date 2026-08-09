/**
 * In-memory retry tracker for failed title generation.
 *
 * When `runTitleTask` fails (LLM unavailable, network error, rate limit), the
 * session keeps its crude instant-preview title forever. This module tracks
 * which sessions need a retry and executes them on session-focus and app-resume
 * events — opportunistic re-attempts that don't block the user.
 *
 * State is purely in-memory: no Dexie persistence, no schema changes. A page
 * reload clears all retry state by design (the title remains the instant
 * preview until the next first-turn triggers generation fresh).
 */

import { computeBackoffDelay } from "@cognia/primitives"
import { getSession } from "@/lib/db/sessions"
import { updateSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"
import {
  isPlaceholderTitle,
  isInstantPreviewTitle,
  isTitleInFlight,
  runTitleTask,
} from "./run-title-task"

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum retry attempts before giving up on a session's title. */
export const MAX_RETRIES = 3

/** Maximum tracked entries to prevent memory leaks from abandoned sessions. */
const MAX_ENTRIES = 50

const BACKOFF_OPTS = {
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  jitter: { kind: "ratio" as const, ratio: 0.3 },
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface TitleRetryEntry {
  sessionId: string
  attempts: number
  lastAttemptAt: number
  /** Text inputs needed to reconstruct the runTitleTask call. */
  sourceText: string
  resultText?: string
  locale?: string
  kind?: "chat" | "work"
}

// ── State ────────────────────────────────────────────────────────────────────

const retryMap = new Map<string, TitleRetryEntry>()

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Mark a session for future retry after a title generation failure.
 * Only stores the text inputs needed for reconstruction — closures and
 * refs are rebuilt at retry time from the session row and settings store.
 */
export function markTitleFailed(
  sessionId: string,
  partial: Pick<TitleRetryEntry, "sourceText" | "resultText" | "locale" | "kind">
): void {
  const existing = retryMap.get(sessionId)
  retryMap.set(sessionId, {
    sessionId,
    attempts: existing ? existing.attempts + 1 : 0,
    lastAttemptAt: Date.now(),
    sourceText: partial.sourceText,
    resultText: partial.resultText,
    locale: partial.locale,
    kind: partial.kind,
  })
  evictIfOverCapacity()
}

/**
 * Clear retry tracking for a session (on success or when the user renames).
 */
export function clearTitleRetry(sessionId: string): void {
  retryMap.delete(sessionId)
}

/**
 * Check and execute a retry if eligible. Called on session focus change
 * and app resume. No-op when no retry is pending, backoff hasn't elapsed,
 * max attempts reached, or the title no longer needs upgrading.
 *
 * Never throws — fire-and-forget.
 */
export async function retryTitleIfNeeded(sessionId: string): Promise<void> {
  try {
    const entry = retryMap.get(sessionId)
    if (!entry) return
    if (entry.attempts >= MAX_RETRIES) {
      retryMap.delete(sessionId)
      return
    }

    // Backoff gate: not enough time elapsed since last attempt.
    const delay = computeBackoffDelay(entry.attempts, BACKOFF_OPTS)
    if (Date.now() - entry.lastAttemptAt < delay) return

    // In-flight guard: another generation is already running.
    if (isTitleInFlight(sessionId)) return

    // Read fresh session state.
    const session = await getSession(sessionId)
    if (!session) {
      retryMap.delete(sessionId)
      return
    }

    // Title was manually renamed — no more auto-generation.
    if (session.titleAuto === false) {
      retryMap.delete(sessionId)
      return
    }

    // Title was already upgraded by another path (e.g., a concurrent turn).
    const titleNeedsUpgrade =
      isPlaceholderTitle(session.title) || isInstantPreviewTitle(session.title, entry.sourceText)
    if (!titleNeedsUpgrade) {
      retryMap.delete(sessionId)
      return
    }

    // Attempt the retry.
    const settings = useSettingsStore.getState().settings
    const titleCfg = settings?.conversationTitle

    const result = await runTitleTask({
      session,
      appSettings: settings,
      override: titleCfg,
      featureId: "conversation-title-retry",
      sourceText: entry.sourceText,
      resultText: entry.resultText,
      locale: entry.locale ?? settings?.language,
      kind: entry.kind,
      currentTitle: session.title,
      dedupKey: sessionId,
      isStillAuto: async () => {
        const fresh = await getSession(sessionId).catch(() => undefined)
        return !fresh || fresh.titleAuto !== false
      },
      persist: (title) => updateSession(sessionId, { title, titleAuto: true }),
    })

    if (result) {
      // Success — clear retry state.
      retryMap.delete(sessionId)
    } else {
      // Failed again — increment.
      entry.attempts += 1
      entry.lastAttemptAt = Date.now()
    }
  } catch {
    // Never throw from this fire-and-forget handler.
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/** @internal For tests: inspect current retry state for a session. */
export function _getRetryState(sessionId: string): TitleRetryEntry | null {
  return retryMap.get(sessionId) ?? null
}

/** @internal For tests: reset all retry state. */
export function _resetAllRetries(): void {
  retryMap.clear()
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Evict the oldest entry when we exceed the cap, preventing unbounded memory
 * growth from abandoned sessions.
 */
function evictIfOverCapacity(): void {
  if (retryMap.size <= MAX_ENTRIES) return
  let oldest: { key: string; at: number } | null = null
  for (const [key, entry] of retryMap) {
    if (!oldest || entry.lastAttemptAt < oldest.at) {
      oldest = { key, at: entry.lastAttemptAt }
    }
  }
  if (oldest) retryMap.delete(oldest.key)
}
