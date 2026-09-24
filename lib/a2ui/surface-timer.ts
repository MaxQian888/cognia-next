/**
 * A2UI surface timer runtime.
 *
 * The interval primitive behind the built-in timer / stopwatch / pomodoro
 * mini-apps (the `timer` catalog template and the generator's timer and
 * pomodoro apps). A surface opts in purely through its data model:
 *
 * - `/totalSeconds` — countdown length; `0` (or absent) means stopwatch.
 * - `/seconds`      — elapsed seconds (written by the runtime).
 * - `/display`      — `MM:SS` text the template binds to (written).
 * - `/progress`     — 0..100 countdown progress (written; untouched for stopwatches).
 * - `/isRunning`    — run flag (written). Clearing it from anywhere stops the ticker.
 * - `/mode`         — optional; `"stopwatch"` forces counting up, every other
 *                     value (`timer`, `pomodoro`, `countdown`) counts down when a
 *                     length is set.
 *
 * Design constraints:
 * - Every tick reads the LIVE data model through the host. The previous
 *   implementation captured a render-time snapshot of the surfaces map inside
 *   `setInterval`, so its first tick saw the pre-start `isRunning: false` and
 *   stopped itself — Start never counted.
 * - Elapsed time is measured against a wall-clock anchor, not by counting
 *   ticks, so throttled background timers (hidden WKWebView, background tabs)
 *   do not stretch a 25-minute pomodoro.
 * - Timers are registered at module scope keyed by surface id. The built-in
 *   action handler can be re-bound to a different hook instance (the most
 *   recently mounted builder wins), so a per-hook registry would orphan
 *   intervals that a later Pause could no longer find.
 * - Starting ignores a persisted `isRunning: true` that has no live ticker
 *   (surfaces rehydrate from localStorage after a reload); otherwise Start
 *   would be a dead button until the user pressed Pause first.
 */

/** Direction a surface timer counts in. */
export type SurfaceTimerDirection = "countdown" | "countup"

/** Reads the live data model of a surface; `undefined` once it is gone. */
export type SurfaceTimerReader = (surfaceId: string) => Record<string, unknown> | undefined

/** Writes one JSON-pointer path of a surface's data model. */
export type SurfaceTimerWriter = (surfaceId: string, path: string, value: unknown) => void

/** Store access the runtime needs; injected so the runtime stays store-agnostic. */
export interface SurfaceTimerHost {
  read: SurfaceTimerReader
  write: SurfaceTimerWriter
}

/** Values the runtime projects into a surface's data model for one instant. */
export interface SurfaceTimerFrame {
  seconds: number
  display: string
  /** `null` leaves `/progress` untouched (stopwatches have no end). */
  progress: number | null
  finished: boolean
}

/** Tick cadence. Sub-second so the display flips close to each whole second. */
export const SURFACE_TIMER_TICK_MS = 250

function toWholeSeconds(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value) : value
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.floor(numeric)
}

/** `MM:SS`; minutes are not wrapped, so an hour renders as `60:00`. */
export function formatTimerDisplay(totalSeconds: number): string {
  const safe = toWholeSeconds(totalSeconds)
  const minutes = Math.floor(safe / 60)
  const secs = safe % 60
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}

/** Resolve whether a timer surface counts down (has a length) or up. */
export function resolveTimerDirection(dataModel: Record<string, unknown>): SurfaceTimerDirection {
  if (dataModel.mode === "stopwatch") return "countup"
  return toWholeSeconds(dataModel.totalSeconds) > 0 ? "countdown" : "countup"
}

/** Pure projection of elapsed seconds into the bound data-model values. */
export function computeTimerFrame(
  direction: SurfaceTimerDirection,
  totalSeconds: number,
  elapsedSeconds: number
): SurfaceTimerFrame {
  const elapsed = toWholeSeconds(elapsedSeconds)
  if (direction === "countup") {
    return {
      seconds: elapsed,
      display: formatTimerDisplay(elapsed),
      progress: null,
      finished: false,
    }
  }
  const total = toWholeSeconds(totalSeconds)
  const seconds = Math.min(elapsed, total)
  const remaining = total - seconds
  return {
    seconds,
    display: formatTimerDisplay(remaining),
    progress: total > 0 ? Math.round((seconds / total) * 100) : 100,
    finished: remaining <= 0,
  }
}

/** Frame shown for a timer at rest (fresh, preset, or reset). */
export function restingTimerFrame(dataModel: Record<string, unknown>): SurfaceTimerFrame {
  return computeTimerFrame(
    resolveTimerDirection(dataModel),
    toWholeSeconds(dataModel.totalSeconds),
    0
  )
}

interface ActiveSurfaceTimer {
  handle: ReturnType<typeof setInterval>
  host: SurfaceTimerHost
  direction: SurfaceTimerDirection
  totalSeconds: number
  /** Elapsed seconds already accumulated when this run started (resume). */
  baseSeconds: number
  /** Wall-clock ms at which this run started. */
  anchorMs: number
}

function writeFrame(
  host: SurfaceTimerHost,
  surfaceId: string,
  current: Record<string, unknown>,
  frame: SurfaceTimerFrame
): void {
  if (current.seconds !== frame.seconds) host.write(surfaceId, "/seconds", frame.seconds)
  if (current.display !== frame.display) host.write(surfaceId, "/display", frame.display)
  if (frame.progress !== null && current.progress !== frame.progress) {
    host.write(surfaceId, "/progress", frame.progress)
  }
}

/**
 * Registry of live surface timers. One instance ({@link surfaceTimers}) serves
 * the whole app; construct another only to inject a clock in tests.
 */
export class SurfaceTimerRuntime {
  private readonly active = new Map<string, ActiveSurfaceTimer>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Whether a ticker is currently running for the surface. */
  isActive(surfaceId: string): boolean {
    return this.active.has(surfaceId)
  }

  /** Number of live tickers (diagnostics and tests). */
  get size(): number {
    return this.active.size
  }

  /**
   * Start (or resume) the timer. A finished countdown restarts from its full
   * length. Returns `false` when the surface does not exist or the timer is
   * already ticking.
   */
  start(surfaceId: string, host: SurfaceTimerHost): boolean {
    if (this.active.has(surfaceId)) return false
    const data = host.read(surfaceId)
    if (!data) return false

    const direction = resolveTimerDirection(data)
    const totalSeconds = toWholeSeconds(data.totalSeconds)
    let baseSeconds = toWholeSeconds(data.seconds)
    if (direction === "countdown" && baseSeconds >= totalSeconds) baseSeconds = 0

    writeFrame(host, surfaceId, data, computeTimerFrame(direction, totalSeconds, baseSeconds))
    host.write(surfaceId, "/isRunning", true)

    const handle = setInterval(() => this.tick(surfaceId), SURFACE_TIMER_TICK_MS)
    this.active.set(surfaceId, {
      handle,
      host,
      direction,
      totalSeconds,
      baseSeconds,
      anchorMs: this.now(),
    })
    return true
  }

  /** Pause, keeping the elapsed time so a later start resumes from it. */
  pause(surfaceId: string, host: SurfaceTimerHost): void {
    const timer = this.active.get(surfaceId)
    const data = host.read(surfaceId)
    if (timer && data) {
      writeFrame(
        host,
        surfaceId,
        data,
        computeTimerFrame(timer.direction, timer.totalSeconds, this.elapsed(timer))
      )
    }
    this.stop(surfaceId)
    if (data) host.write(surfaceId, "/isRunning", false)
  }

  /** Stop and rewind to the resting frame for the current length. */
  reset(surfaceId: string, host: SurfaceTimerHost): void {
    this.stop(surfaceId)
    const data = host.read(surfaceId)
    if (!data) return
    const frame = restingTimerFrame(data)
    host.write(surfaceId, "/isRunning", false)
    host.write(surfaceId, "/seconds", 0)
    host.write(surfaceId, "/display", frame.display)
    host.write(surfaceId, "/progress", 0)
  }

  /** Stop and load a new countdown length. */
  setPreset(surfaceId: string, host: SurfaceTimerHost, totalSeconds: number): void {
    this.stop(surfaceId)
    if (!host.read(surfaceId)) return
    const total = toWholeSeconds(totalSeconds)
    host.write(surfaceId, "/totalSeconds", total)
    host.write(surfaceId, "/seconds", 0)
    host.write(surfaceId, "/display", formatTimerDisplay(total))
    host.write(surfaceId, "/progress", 0)
    host.write(surfaceId, "/isRunning", false)
  }

  /** Clear the ticker only; the data model is left as-is. */
  stop(surfaceId: string): void {
    const timer = this.active.get(surfaceId)
    if (!timer) return
    clearInterval(timer.handle)
    this.active.delete(surfaceId)
  }

  /** Clear every ticker (teardown and tests). */
  stopAll(): void {
    for (const surfaceId of [...this.active.keys()]) this.stop(surfaceId)
  }

  private elapsed(timer: ActiveSurfaceTimer): number {
    return timer.baseSeconds + Math.floor(Math.max(0, this.now() - timer.anchorMs) / 1000)
  }

  private tick(surfaceId: string): void {
    const timer = this.active.get(surfaceId)
    if (!timer) return
    const data = timer.host.read(surfaceId)
    // Surface deleted, or its run flag cleared by another writer (an AI edit,
    // a data-model replace, another handler): the ticker must not resurrect it.
    if (!data || data.isRunning !== true) {
      this.stop(surfaceId)
      return
    }
    const frame = computeTimerFrame(timer.direction, timer.totalSeconds, this.elapsed(timer))
    writeFrame(timer.host, surfaceId, data, frame)
    if (frame.finished) {
      this.stop(surfaceId)
      timer.host.write(surfaceId, "/isRunning", false)
    }
  }
}

/** App-wide timer registry used by the built-in A2UI action handlers. */
export const surfaceTimers = new SurfaceTimerRuntime()
