/**
 * Trace debug session — a time-bounded arming switch for high-fidelity capture.
 *
 * The trace estate used to have exactly one content knob:
 * `transports.agentTrace.captureContent`, a boolean with no expiry. Turning it
 * on meant every prompt and every tool payload was persisted, forever, until
 * someone remembered to turn it off — so in practice it stayed off and nobody
 * could reproduce anything.
 *
 * This replaces the single boolean with what Claude Code's own OTel surface
 * models as three independent env vars (`OTEL_LOG_USER_PROMPTS`,
 * `..._TOOL_DETAILS`, `..._RAW_API_BODIES`), plus our own `deltas` tier, and
 * makes the whole thing expire on a clock. Arming is a deliberate, bounded act:
 * "capture everything for the next 15 minutes while I reproduce this".
 *
 * Three properties are load-bearing:
 *
 *  - **Auto-expiring.** Expiry is evaluated on every read, not by a timer, so a
 *    session that was armed before a crash/reload is already expired when the
 *    app comes back rather than silently capturing forever.
 *  - **Local-only.** The state lives in `localStorage` under a key that is NOT
 *    in `SNAPSHOT_DOMAIN_KEYS` (`lib/data/domain/index.ts`), which is an
 *    allowlist — so it can never ride a backup, an export, or a transfer
 *    package. Pinned by a test.
 *  - **Excluded from the diagnostic package** (ADR-0102). `.cognia-diagnostic`
 *    is built from the registered support-report sections; this module
 *    registers none. A debug session exists to capture user content locally,
 *    and shipping that content to an issue tracker is the one thing it must
 *    never do.
 */

/**
 * What a session arms. Each tier is independent — reproducing a tool bug needs
 * `toolDetails` and nothing else.
 */
export const TRACE_DEBUG_TIERS = ["deltas", "prompts", "toolDetails", "rawBodies"] as const

export type TraceDebugTier = (typeof TRACE_DEBUG_TIERS)[number]

export interface TraceDebugSession {
  /** Epoch ms the session was armed. */
  startedAt: number
  /** Epoch ms the session stops capturing. Always `<= startedAt + MAX`. */
  expiresAt: number
  /** Armed tiers, deduped and ordered as in {@link TRACE_DEBUG_TIERS}. */
  tiers: readonly TraceDebugTier[]
  /**
   * Restrict capture to one chat session. Absent means every session — useful
   * for a bug that only reproduces on a cold start, costly otherwise.
   */
  sessionId?: string
}

export interface ArmTraceDebugSessionInput {
  /** Clamped into `[60_000, MAX_TRACE_DEBUG_DURATION_MS]`. */
  durationMs?: number
  tiers?: readonly TraceDebugTier[]
  sessionId?: string
}

export const TRACE_DEBUG_STORAGE_KEY = "cognia.observability.trace-debug-session"

/** Long enough to reproduce something by hand, short enough to forget about. */
export const DEFAULT_TRACE_DEBUG_DURATION_MS = 15 * 60_000

/** Hard ceiling. An "always on" debug session is the state this module exists to prevent. */
export const MAX_TRACE_DEBUG_DURATION_MS = 60 * 60_000

/** Below this the session expires before the user can reproduce anything. */
export const MIN_TRACE_DEBUG_DURATION_MS = 60_000

const listeners = new Set<() => void>()

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    // Private-mode / SSR / a shell with storage disabled — treat as disarmed.
    return undefined
  }
}

function notify(): void {
  syncCountdownTimer()
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A subscriber must not be able to break arming.
    }
  }
}

function normalizeTiers(tiers: readonly TraceDebugTier[] | undefined): TraceDebugTier[] {
  if (!tiers || tiers.length === 0) return [...TRACE_DEBUG_TIERS]
  const wanted = new Set(tiers)
  return TRACE_DEBUG_TIERS.filter((tier) => wanted.has(tier))
}

function parse(raw: string | null): TraceDebugSession | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<TraceDebugSession>
    if (typeof value?.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null
    let tiers: TraceDebugTier[]
    if (Array.isArray(value.tiers)) {
      const known = value.tiers.filter((tier): tier is TraceDebugTier =>
        (TRACE_DEBUG_TIERS as readonly string[]).includes(tier as string)
      )
      // A record that stored tiers but none we recognise is corrupt, not
      // "everything on" — defaulting it to full capture would arm more than
      // the user ever asked for.
      if (known.length === 0) return null
      tiers = normalizeTiers(known)
    } else {
      tiers = normalizeTiers(undefined)
    }
    return {
      startedAt:
        typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
          ? value.startedAt
          : value.expiresAt - DEFAULT_TRACE_DEBUG_DURATION_MS,
      expiresAt: value.expiresAt,
      tiers,
      ...(typeof value.sessionId === "string" && value.sessionId.length > 0
        ? { sessionId: value.sessionId }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * Arm a debug session, replacing any session already armed.
 *
 * The duration is clamped rather than rejected: a caller asking for 24 hours
 * gets the ceiling, not an error and not 24 hours.
 */
export function armTraceDebugSession(
  input: ArmTraceDebugSessionInput = {},
  now: number = Date.now()
): TraceDebugSession {
  const requested = Number.isFinite(input.durationMs)
    ? (input.durationMs as number)
    : DEFAULT_TRACE_DEBUG_DURATION_MS
  const durationMs = Math.min(
    MAX_TRACE_DEBUG_DURATION_MS,
    Math.max(MIN_TRACE_DEBUG_DURATION_MS, requested)
  )
  const session: TraceDebugSession = {
    startedAt: now,
    expiresAt: now + durationMs,
    tiers: normalizeTiers(input.tiers),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  }
  try {
    storage()?.setItem(TRACE_DEBUG_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Storage full / blocked — the session simply does not arm. Reporting
    // success here would leave the caller believing it captured a repro.
  }
  notify()
  return session
}

/** Disarm immediately. Idempotent. */
export function disarmTraceDebugSession(): void {
  try {
    storage()?.removeItem(TRACE_DEBUG_STORAGE_KEY)
  } catch {
    // Nothing to do — a session we cannot clear is one we also cannot read.
  }
  notify()
}

/**
 * The armed session, or `null`. An expired record is cleared as a side effect
 * of reading it, so an abandoned session cannot linger in storage.
 */
export function getTraceDebugSession(now: number = Date.now()): TraceDebugSession | null {
  const store = storage()
  if (!store) return null
  let raw: string | null
  try {
    raw = store.getItem(TRACE_DEBUG_STORAGE_KEY)
  } catch {
    return null
  }
  const session = parse(raw)
  if (!session) {
    if (raw !== null) {
      // Corrupt record — drop it rather than re-parsing it on every event.
      try {
        store.removeItem(TRACE_DEBUG_STORAGE_KEY)
      } catch {
        // Best effort.
      }
    }
    return null
  }
  if (session.expiresAt <= now) {
    try {
      store.removeItem(TRACE_DEBUG_STORAGE_KEY)
    } catch {
      // Best effort — the expiry check above already refuses to capture.
    }
    return null
  }
  return session
}

/** An armed session plus the countdown a UI needs, so no view calls `Date.now`. */
export interface TraceDebugSessionSnapshot extends TraceDebugSession {
  /** Whole minutes left, rounded up. Refreshed by the countdown tick. */
  remainingMinutes: number
}

/** Cached snapshot for `useSyncExternalStore`, keyed by its serialized value. */
let snapshotKey: string | null = null
let snapshotValue: TraceDebugSessionSnapshot | null = null

/**
 * Referentially-stable read for `useSyncExternalStore`.
 *
 * Two things this has to get right. {@link getTraceDebugSession} parses on every
 * call and so returns a new object each time, which React treats as a changed
 * snapshot and re-renders forever — hence the memo. And the countdown belongs
 * HERE rather than in a component, because reading the clock during render is
 * impure (`react-hooks/purity`) and would make the value depend on whenever the
 * component happened to re-render.
 */
export function getTraceDebugSessionSnapshot(): TraceDebugSessionSnapshot | null {
  const now = Date.now()
  const session = getTraceDebugSession(now)
  const next: TraceDebugSessionSnapshot | null = session
    ? { ...session, remainingMinutes: Math.max(0, Math.ceil((session.expiresAt - now) / 60_000)) }
    : null
  const key = next ? JSON.stringify(next) : null
  if (key !== snapshotKey) {
    snapshotKey = key
    snapshotValue = next
  }
  return snapshotValue
}

/** Server snapshot: nothing is ever armed during prerender. */
export function getTraceDebugSessionServerSnapshot(): TraceDebugSessionSnapshot | null {
  return null
}

/** How often the countdown re-notifies subscribers while a session is armed. */
const COUNTDOWN_TICK_MS = 30_000

let countdownTimer: ReturnType<typeof setInterval> | null = null

/**
 * Keep a countdown ticking only while it is worth ticking: at least one
 * subscriber AND an armed session. A permanent interval in a long-lived desktop
 * process is exactly the kind of idle wakeup this app tries not to have.
 */
function syncCountdownTimer(): void {
  const wanted = listeners.size > 0 && getTraceDebugSession() !== null
  if (wanted && countdownTimer === null) {
    countdownTimer = setInterval(() => {
      if (getTraceDebugSession() === null) {
        // Expired between ticks — notify once so the UI clears, then stop.
        syncCountdownTimer()
      }
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // A subscriber must not be able to stop the countdown.
        }
      }
    }, COUNTDOWN_TICK_MS)
  } else if (!wanted && countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

/**
 * Whether `tier` is currently capturing for `sessionId`.
 *
 * This is called on the hot path (once per streamed event), so it stays a
 * synchronous storage read with no allocation beyond the parse.
 */
export function isTraceDebugArmed(
  tier: TraceDebugTier,
  sessionId?: string,
  now: number = Date.now()
): boolean {
  const session = getTraceDebugSession(now)
  if (!session) return false
  if (!session.tiers.includes(tier)) return false
  // A session-scoped debug run must not capture other conversations' content.
  if (session.sessionId && sessionId && session.sessionId !== sessionId) return false
  if (session.sessionId && !sessionId) return false
  return true
}

/** Milliseconds left, or 0 when nothing is armed. */
export function traceDebugRemainingMs(now: number = Date.now()): number {
  const session = getTraceDebugSession(now)
  return session ? Math.max(0, session.expiresAt - now) : 0
}

/**
 * Observe arm/disarm. Fires for in-window changes and for other-window writes
 * via the `storage` event, so a toolbar badge and the settings row never
 * disagree. Expiry is not an event — subscribers re-read on their own cadence.
 */
export function subscribeTraceDebugSession(listener: () => void): () => void {
  listeners.add(listener)
  syncCountdownTimer()
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === TRACE_DEBUG_STORAGE_KEY) listener()
  }
  const win = typeof window !== "undefined" ? window : undefined
  win?.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    syncCountdownTimer()
    win?.removeEventListener("storage", onStorage)
  }
}
