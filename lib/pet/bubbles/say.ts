// Put an authored line in the pet's bubble.
//
// Every other bubble path either picks a template key or comes back from a
// model. This one takes a caller's own text, which is why it carries the full
// admission sequence: PII gate, sanitize, then the shared speak limiter.
//
// It spends `getSpeakLimiter()` rather than a bucket of its own. That limiter
// is already the shared budget across every talk source, so an agent that
// wants the pet to say something cannot out-talk the person using it.
//
// The bubble clears itself. `usePetInsight` previously set one that never did,
// so a teaser could sit on screen indefinitely.

import { sanitizeReply } from "@/lib/pet/bubbles/speak"
import { getSpeakLimiter } from "@/lib/pet/bubbles/speak-limiter"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetOneShot } from "@/types/pet"
import { hasNoLeakingPii } from "@cognia/redact"

/** How long an authored bubble stays up when the caller names no duration. */
export const DEFAULT_SAY_DURATION_MS = 6000
const MIN_SAY_DURATION_MS = 1000
const MAX_SAY_DURATION_MS = 15000

export type SayRefusal = "empty" | "pii" | "rate-limited" | "muted"

export type SayResult =
  { ok: true; text: string; clearsAt: number } | { ok: false; reason: SayRefusal }

export interface SayDeps {
  now?: () => number
  muted?: boolean
  setBubble?: (bubble: { text: string; origin: "template" | "llm" | "system" } | null) => void
  enqueueOneShot?: (shot: PetOneShot) => void
  schedule?: (fn: () => void, ms: number) => void
  limiter?: { tryAcquire: (now: number) => boolean }
}

export interface SayOptions {
  /** Flourish to play alongside the line. */
  emotion?: PetOneShot
  /** How long to hold the bubble, clamped to 1s..15s. */
  durationMs?: number
  /** Where the line came from, for the bubble's styling. */
  origin?: "template" | "llm" | "system"
}

/**
 * Say `text` in the bubble. Never throws: a refusal is a value, because the
 * callers are a tool runner and a hook, and neither should turn a muted pet
 * into an error.
 */
export function sayAsPet(text: string, opts: SayOptions = {}, deps: SayDeps = {}): SayResult {
  if (deps.muted) return { ok: false, reason: "muted" }

  const clean = sanitizeReply(text)
  if (!clean) return { ok: false, reason: "empty" }
  if (!hasNoLeakingPii(clean)) return { ok: false, reason: "pii" }

  const now = deps.now?.() ?? Date.now()
  const limiter = deps.limiter ?? getSpeakLimiter()
  if (!limiter.tryAcquire(now)) return { ok: false, reason: "rate-limited" }

  const durationMs = Math.min(
    MAX_SAY_DURATION_MS,
    Math.max(MIN_SAY_DURATION_MS, Math.floor(opts.durationMs ?? DEFAULT_SAY_DURATION_MS))
  )
  const setBubble = deps.setBubble ?? ((b) => usePetStore.getState().setBubble(b))
  const enqueue =
    deps.enqueueOneShot ?? ((s: PetOneShot) => usePetStore.getState().enqueueOneShot(s))
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))

  setBubble({ text: clean, origin: opts.origin ?? "llm" })
  if (opts.emotion) enqueue(opts.emotion)
  schedule(() => {
    // Only clear if it is still ours: a newer bubble must not be cut short.
    const current = usePetStore.getState().bubble
    if (current?.text === clean) setBubble(null)
  }, durationMs)

  return { ok: true, text: clean, clearsAt: now + durationMs }
}
