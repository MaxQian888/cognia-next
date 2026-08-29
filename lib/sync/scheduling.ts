/**
 * Main-thread pacing for the companion sync pipeline (ADR-0027).
 *
 * The orchestrator's work is a long series of small, synchronous bursts: parse
 * a `sync_pull` response, hand a row array to Dexie, repeat for 25 tables. Each
 * burst is individually cheap and collectively enough to hold the main thread
 * past a frame budget, which is what a first pairing feels like — the shell
 * paints, then freezes while the mirror fills.
 *
 * Nothing here makes the sync faster. It makes it *interruptible*: the pipeline
 * hands the thread back often enough that input, animation and paint keep
 * running while the mirror fills behind them.
 *
 * Two yields, in the order the platform prefers them:
 *
 *   `scheduler.yield()`    continues at the *same* priority after the browser
 *                          has done its work, so a long drain can't be starved
 *                          by lower-priority tasks it yielded to. This is the
 *                          path the shells that matter actually take.
 *   `setTimeout(0)`        everywhere else. Nested timers are clamped to ~4 ms,
 *                          which is a real cost and an accepted one.
 *
 * `MessageChannel` is the usual way to dodge that clamp and is deliberately
 * NOT used: under jsdom its ports deliver, but at roughly 600 ms per message
 * after the first, so a drain that yields between pages takes minutes in the
 * test environment while looking correct in a browser. A yield primitive whose
 * cost depends on the host that badly is not one worth the 4 ms it saves.
 *
 * `whenIdle` is the coarser one: it waits for a genuinely quiet moment (with a
 * deadline, so a permanently busy tab still makes progress) and is used between
 * sync *stages*, where "later" is the correct answer and "next macrotask" is
 * not.
 */

interface SchedulerWithYield {
  yield?: () => Promise<void>
}

interface IdleGlobal {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
}

/**
 * Hand the main thread back once.
 *
 * Always resolves; a scheduler that rejects (an aborted task signal on some
 * builds) falls through to the macrotask path rather than failing the pull.
 */
export async function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerWithYield }).scheduler
  if (scheduler && typeof scheduler.yield === "function") {
    try {
      await scheduler.yield()
      return
    } catch {
      // Fall through — the point is to yield, not to yield a particular way.
    }
  }
  await macrotask()
}

function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Wait for an idle moment, or `timeoutMs`, whichever comes first.
 *
 * The timeout is not a nicety: `requestIdleCallback` never fires while a tab
 * is busy or hidden in some browsers, and a background sync stage that never
 * starts is worse than one that starts at a bad moment.
 */
export function whenIdle(timeoutMs = DEFAULT_IDLE_TIMEOUT_MS): Promise<void> {
  const idle = (globalThis as IdleGlobal).requestIdleCallback
  if (typeof idle !== "function") return macrotask()
  return new Promise<void>((resolve) => {
    idle(() => resolve(), { timeout: timeoutMs })
  })
}

/** Deadline for {@link whenIdle} — a hidden tab must still drain its stages. */
export const DEFAULT_IDLE_TIMEOUT_MS = 500

/**
 * Split `rows` into slices of at most `size`.
 *
 * Returns the input array itself when it already fits, so the common case (a
 * table whose delta is a handful of rows) allocates nothing.
 */
export function chunk<T>(rows: readonly T[], size: number): readonly (readonly T[])[] {
  if (size <= 0 || rows.length <= size) return [rows]
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size))
  }
  return out
}

/**
 * Run `apply` over `rows` in slices, yielding between them.
 *
 * One `bulkPut` of a whole message page is a single job the browser cannot
 * interrupt: Dexie serialises every row, and the structured clone into
 * IndexedDB happens in one go. Sliced, the same work becomes N jobs with a
 * paint opportunity between each.
 *
 * A single slice is applied without yielding at all — the yield is the cost
 * this avoids paying when there is nothing to interleave with.
 */
export async function applyInSlices<T>(
  rows: readonly T[],
  size: number,
  apply: (slice: readonly T[]) => Promise<void>
): Promise<void> {
  if (rows.length === 0) return
  const slices = chunk(rows, size)
  for (let i = 0; i < slices.length; i++) {
    await apply(slices[i])
    if (i < slices.length - 1) await yieldToMain()
  }
}
