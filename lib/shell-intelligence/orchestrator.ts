/**
 * Merging, ranking, and scheduling for `!`-mode completion.
 *
 * Two concerns that both have to be right for the list to feel like a shell's:
 *
 *  - **Merging** — several sources answer the same position, and they overlap.
 *    `git` is a builtin-list miss, a spec hit, and a `$PATH` hit at once. The
 *    user should see it once, described by whichever source knows the most.
 *  - **Scheduling** — the host lookups are async and the user keeps typing, so
 *    a slow answer for `k` must never overwrite a fast answer for `kubectl`.
 *    Every request carries a sequence number and a late one is dropped.
 *
 * The ranking is pure and the scheduler takes its clock and its sources by
 * injection, so both are testable without a Host or a React tree.
 */

import {
  COMPLETION_DEBOUNCE_MS,
  COMPLETION_KIND_PRIORITY,
  MAX_COMPLETIONS,
  type ShellCompletion,
  type ShellIntelligenceRequest,
} from "./types"
import { collectCandidates, hostCompletionSources, type CompletionSources } from "./providers"

/**
 * Dedupe by what acceptance writes, then rank.
 *
 * Keyed on `insertText` plus the replaced span rather than on the label: two
 * candidates that write the same text over the same span ARE the same
 * completion however differently they are described, and two that write it over
 * different spans are not.
 *
 * The survivor of a duplicate is the higher-priority kind — so `git` stays a
 * `command` with the spec's description rather than becoming an anonymous
 * `$PATH` hit — and a survivor missing a `detail` inherits the loser's, which
 * is how a `$PATH` executable picks up its spec's description.
 */
export function rankCompletions(candidates: readonly ShellCompletion[]): ShellCompletion[] {
  const byKey = new Map<string, ShellCompletion>()
  for (const candidate of candidates) {
    const key = `${candidate.from}:${candidate.to}:${candidate.insertText}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, candidate)
      continue
    }
    const winner =
      COMPLETION_KIND_PRIORITY[candidate.kind] > COMPLETION_KIND_PRIORITY[existing.kind]
        ? candidate
        : existing
    const loser = winner === candidate ? existing : candidate
    byKey.set(key, {
      ...winner,
      ...(winner.detail ? {} : loser.detail ? { detail: loser.detail } : {}),
      ...(winner.continues || loser.continues ? { continues: true } : {}),
    })
  }

  return Array.from(byKey.values())
    .sort((a, b) => {
      const kind = COMPLETION_KIND_PRIORITY[b.kind] - COMPLETION_KIND_PRIORITY[a.kind]
      if (kind !== 0) return kind
      // Within a kind, shortest first: the closest match to what was typed is
      // the one the user most likely meant (`git` before `git-lfs`).
      if (a.insertText.length !== b.insertText.length) {
        return a.insertText.length - b.insertText.length
      }
      return a.insertText.localeCompare(b.insertText)
    })
    .slice(0, MAX_COMPLETIONS)
}

/** A completion result, tagged with the request it answers. */
export interface CompletionResult {
  requestId: number
  request: ShellIntelligenceRequest
  completions: ShellCompletion[]
}

export interface CompletionSchedulerOptions {
  sources?: CompletionSources
  debounceMs?: number
  /** Test seam for the debounce timer. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * Debounces completion requests, cancels the in-flight one, and delivers only
 * the answer to the newest request.
 *
 * `cancel()` is the Escape key and the "mode left" teardown: it stops the timer
 * AND aborts the running query, so a host call cannot deliver into a closed
 * list.
 */
export class CompletionScheduler {
  private readonly sources: CompletionSources
  private readonly debounceMs: number
  private readonly setTimeoutFn: NonNullable<CompletionSchedulerOptions["setTimeoutFn"]>
  private readonly clearTimeoutFn: NonNullable<CompletionSchedulerOptions["clearTimeoutFn"]>
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  private sequence = 0
  /** The newest request issued — anything older is stale by definition. */
  private latest = 0

  constructor(options: CompletionSchedulerOptions = {}) {
    this.sources = options.sources ?? hostCompletionSources
    this.debounceMs = options.debounceMs ?? COMPLETION_DEBOUNCE_MS
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  }

  /**
   * Schedule a query. `onResult` fires at most once, and never for a request
   * that a newer one has already superseded.
   */
  request(request: ShellIntelligenceRequest, onResult: (result: CompletionResult) => void): number {
    this.cancel()
    const requestId = ++this.sequence
    this.latest = requestId
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      const controller = new AbortController()
      this.controller = controller
      void collectCandidates(request, this.sources, controller.signal)
        .then((candidates) => {
          if (controller.signal.aborted || requestId !== this.latest) return
          onResult({ requestId, request, completions: rankCompletions(candidates) })
        })
        .catch(() => {
          // A source failed. The list simply has fewer answers; the composer
          // must not surface a completion error over a shell line.
        })
        .finally(() => {
          if (this.controller === controller) this.controller = null
        })
    }, this.debounceMs)
    return requestId
  }

  /** Stop the pending timer and abort the in-flight query. */
  cancel(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    this.controller?.abort()
    this.controller = null
  }

  /** Whether a query is scheduled or running. */
  get busy(): boolean {
    return this.timer !== null || this.controller !== null
  }
}
