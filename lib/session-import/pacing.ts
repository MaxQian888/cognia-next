// Work pacing for the session-import scan/parse loops.
//
// Two separate problems, two primitives:
//
//   • `mapBounded` — reads are Tauri IPC: each `await readTextFile` spends most
//     of its time in transit, so a serial loop pays N round-trip latencies.
//     A small worker pool overlaps the waits while keeping in-flight reads
//     (and their full string bodies) bounded — the unbounded `Promise.all`
//     over a corpus is exactly what used to pin gigabytes in the webview.
//
//   • `everyBudget`/`yieldToMain` — parsing is synchronous CPU: JSON.parse +
//     StoredMessage allocation run on the main thread, so a long enough run
//     starves rendering no matter how few files are read. Yielding a
//     macrotask every `budgetMs` of continuous work gives the event loop a
//     paint slot — the difference between "busy but alive" and "卡死".

/**
 * Map `items` through `fn` with at most `limit` invocations in flight,
 * preserving input order in the result. `limit <= 0` behaves as 1 (serial).
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lanes = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        out[index] = await fn(items[index], index)
      }
    })
  )
  return out
}

/**
 * Yield one macrotask so the renderer can paint / handle input. Prefers
 * `scheduler.yield()` (real task scheduling, no timer clamp) where the
 * platform offers it; falls back to a zero-timeout elsewhere.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === "function") return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Returns a function to `await` inside a hot loop: it yields to the main
 * thread only when `budgetMs` have elapsed since the last yield, so a loop
 * over thousands of small items pays near-zero overhead while a run of
 * heavy items still lets the UI breathe between them.
 */
export function everyBudget(budgetMs = 32): () => Promise<void> {
  let last = Date.now()
  return async () => {
    const now = Date.now()
    if (now - last >= budgetMs) {
      last = now
      await yieldToMain()
    }
  }
}
