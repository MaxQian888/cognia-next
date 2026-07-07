/**
 * PR reaction reducer — the react half of the Agent Team PR feedback loop and
 * the port of agent-orchestrator's `lifecycle/reactions.go`. Given a
 * {@link PrObservation}, it produces at most one guarded "review_pickup" nudge
 * per poll and routes it to the responsible teammate.
 *
 * Faithful to AO's precedence and dedup:
 *   - CI failing takes precedence and short-circuits (fix CI before review).
 *   - Then requested-changes / unresolved human comments.
 *   - Then a merge conflict.
 *   - `sendOnce` de-dups by a per-key signature (identical feedback never
 *     re-fires; a new commit / new comment does), caps attempts per key, and is
 *     restart-persistent via {@link PrReactionSignature}.
 *
 * Two safety passes AO also performs, adapted to this repo:
 *   - {@link sanitizeControlChars} strips terminal escapes from attacker-
 *     influenced CI logs / review bodies (AO's `SanitizeControlChars`).
 *   - {@link hasNoLeakingPii} → {@link redactText} gates the outbound message,
 *     because a nudge carrying PR-comment text leaves the device to the model
 *     (the same gate `lib/connectors/ai-loop/safe-send-prompt.ts` applies).
 *
 * The reducer also runs each candidate through {@link canNudge} so PR nudges
 * share the team's per-member hourly cap / busy-signal guard with the wired
 * rate-limit-resume nudge.
 */

import { canNudge, computeNextRetryAt, type NudgeRecord } from "@/lib/ai/agent/team/nudge-guard"
import { sanitizeControlChars } from "@/lib/github/pr-observe/sanitize"
import {
  collectUnresolvedComments,
  hasUnresolvedNonBotComments,
} from "@/lib/github/pr-observe/predicates"
import type { PrObservation } from "@/lib/github/pr-observe/types"
import { hasNoLeakingPii, redactText } from "@/lib/twin/ingest/redact"

/** Max nudges for the same review key before it stops re-firing (AO reviewMaxNudge). */
export const REVIEW_MAX_NUDGE = 3

export type PrNudgeCategory = "ci" | "review" | "conflict"

/** One candidate nudge derived from an observation (pre-dedup). */
export interface NudgeIntent {
  key: string
  sig: string
  message: string
  maxAttempts: number
  category: PrNudgeCategory
}

/** A nudge that passed all guards and was delivered. */
export interface PrNudge {
  memberId: string
  message: string
  generation: number
  key: string
  category: PrNudgeCategory
}

/** Restart-persistent dedup state (serialized into the observation row). */
export interface PrReactionSignature {
  seen?: Record<string, string>
  attempts?: Record<string, number>
}

export interface PrReactionDeps {
  now: () => number
  maxPerHour?: number
  busyWindowMs?: number
}

export interface PrReactionContext {
  memberId: string
  /** Last tool-activity timestamp for the busy-signal guard. */
  lastToolActivityAt?: number
  /** Delivers a passed nudge (notifier + team mailbox). Called before recording. */
  deliver: (nudge: PrNudge) => void
}

/**
 * Build the (at most one) candidate nudge for an observation. Pure and exported
 * so the precedence is unit-tested without the engine. CI failure short-circuits
 * ahead of review, which short-circuits ahead of a merge conflict.
 *
 * INVARIANT: the returned `message` is control-char-sanitized but NOT PII-gated.
 * It carries attacker-influenced PR text (CI logs, review comments), so it MUST
 * only be delivered through {@link PrReactionEngine.reactIntents} / `sendOnce`,
 * which applies the `hasNoLeakingPii` → `redactText` gate before it leaves the
 * device. Do not deliver `.message` to any sink directly.
 */
export function buildNudgeIntents(obs: PrObservation): NudgeIntent[] {
  if (!obs.fetched || obs.pr.number === 0) return []
  // Terminal / draft PRs never receive a fix nudge.
  if (obs.pr.merged || obs.pr.closed || obs.pr.draft) return []

  const url = obs.pr.url

  // 1) CI failing — highest precedence, short-circuits the rest (AO behavior).
  if (obs.ci.summary === "failing" && obs.ci.failedChecks.length > 0) {
    const names = obs.ci.failedChecks.map((c) => c.name).filter(Boolean)
    const firstTail = obs.ci.failedChecks
      .map((c) => c.logTail)
      .find((t) => t && t.trim().length > 0)
    let message =
      names.length > 0
        ? `CI is failing on your PR: ${names.join(", ")}. Review the output below and push a fix.`
        : "CI is failing on your PR. Review the output below and push a fix."
    if (firstTail) message += `\n\nFailing output:\n${sanitizeControlChars(firstTail)}`
    const sig = obs.ci.failedChecks
      .map((c) => `${c.name}:${c.commitHash}:${c.logTail ?? ""}`)
      .sort()
      .join("|")
    return [{ key: `ci:${url}`, sig, message, maxAttempts: 0, category: "ci" }]
  }

  // 2) Requested changes / unresolved human comments.
  if (
    obs.review.decision === "changes_requested" ||
    hasUnresolvedNonBotComments(obs.review.threads)
  ) {
    const { bodies, ids } = collectUnresolvedComments(obs.review.threads)
    const commentsText = bodies.map((b) => sanitizeControlChars(b)).join("\n\n")
    const message =
      "A reviewer left feedback on your PR. Address it and push." +
      (commentsText ? `\n\n${commentsText}` : "")
    const sig = ids.length > 0 ? [...ids].sort().join(",") : obs.review.decision
    return [
      { key: `review:${url}`, sig, message, maxAttempts: REVIEW_MAX_NUDGE, category: "review" },
    ]
  }

  // 3) Merge conflict.
  if (obs.mergeability.conflict) {
    return [
      {
        key: `merge-conflict:${url}`,
        sig: obs.mergeability.state,
        message: "Your PR has merge conflicts. Rebase onto the base branch and resolve them.",
        maxAttempts: 0,
        category: "conflict",
      },
    ]
  }

  return []
}

/**
 * The stateful reaction engine for one team run. Owns the dedup ledger; the
 * observer hydrates it from persisted signatures and re-serializes it after each
 * delivery so a daemon restart never re-nudges for feedback already sent.
 */
export class PrReactionEngine {
  private readonly seen = new Map<string, string>()
  private readonly attempts = new Map<string, number>()
  private readonly history: NudgeRecord[] = []

  constructor(private readonly deps: PrReactionDeps) {}

  /** Merge previously persisted dedup state (idempotent; existing keys win). */
  hydrate(sig: PrReactionSignature | undefined): void {
    if (!sig) return
    for (const [k, v] of Object.entries(sig.seen ?? {})) {
      if (!this.seen.has(k)) this.seen.set(k, v)
    }
    for (const [k, v] of Object.entries(sig.attempts ?? {})) {
      const cur = this.attempts.get(k)
      if (cur === undefined || v > cur) this.attempts.set(k, v)
    }
  }

  /** Serialize the dedup ledger for persistence. */
  exportSignature(): PrReactionSignature {
    return {
      seen: Object.fromEntries(this.seen),
      attempts: Object.fromEntries(this.attempts),
    }
  }

  /** React to one observation. Returns the nudges actually delivered. */
  react(obs: PrObservation, ctx: PrReactionContext): PrNudge[] {
    return this.reactIntents(buildNudgeIntents(obs), ctx)
  }

  /**
   * Run a set of pre-built intents through the same dedup / attempt-cap / guard /
   * PII pipeline as observation-derived nudges. Used by the internal reviewer to
   * route a `changes_requested` verdict through one shared ledger.
   */
  reactIntents(intents: NudgeIntent[], ctx: PrReactionContext): PrNudge[] {
    const delivered: PrNudge[] = []
    for (const intent of intents) {
      const nudge = this.sendOnce(intent, ctx)
      if (nudge) delivered.push(nudge)
    }
    return delivered
  }

  private sendOnce(intent: NudgeIntent, ctx: PrReactionContext): PrNudge | null {
    const { key, sig, message, maxAttempts, category } = intent

    // Exact-content dedup (persisted): identical feedback never re-fires.
    if (this.seen.get(key) === sig) return null

    const priorAttempts = this.attempts.get(key) ?? 0
    if (maxAttempts > 0 && priorAttempts >= maxAttempts) return null

    // Shared per-member rate / busy / cooldown guard. A distinct sig for the same
    // key is a fresh fingerprint, so a new failure is allowed (subject to the cap).
    const decision = canNudge({
      memberId: ctx.memberId,
      type: "review_pickup",
      fingerprint: `${key}#${sig}`,
      now: this.deps.now(),
      history: this.history,
      maxPerHour: this.deps.maxPerHour,
      lastToolActivityAt: ctx.lastToolActivityAt,
      busyWindowMs: this.deps.busyWindowMs,
    })
    if (!decision.allow) return null

    // PII gate: a nudge carrying PR-comment text must not leak PII to the model.
    const safeMessage = hasNoLeakingPii(message) ? message : redactText(message).redacted

    const generation = priorAttempts + 1
    const nudge: PrNudge = {
      memberId: ctx.memberId,
      message: safeMessage,
      generation,
      key,
      category,
    }

    // Order: deliver → mutate in-memory → (observer persists). Delivering first
    // means a later persist failure degrades to at most one extra nudge rather
    // than silently dropping a real one (AO's ordering rationale).
    ctx.deliver(nudge)

    const now = this.deps.now()
    this.seen.set(key, sig)
    this.attempts.set(key, generation)
    this.history.push({
      memberId: ctx.memberId,
      type: "review_pickup",
      fingerprint: `${key}#${sig}`,
      generation,
      sentAt: now,
      nextRetryAt: computeNextRetryAt(generation, now, ctx.memberId),
    })
    return nudge
  }
}
