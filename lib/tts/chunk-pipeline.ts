/**
 * Depth-1 prefetch pipeline for chunked TTS synthesis.
 *
 * The orchestrator splits long text into chunks. Without prefetch, each cloud
 * chunk is synthesized only *after* the previous chunk finishes playing, so a
 * network round-trip is paid back-to-back with playback and the listener hears
 * a gap between chunks. With prefetch enabled, the next chunk's `produce`
 * (network synthesis) is started *before* the current chunk is consumed
 * (played), overlapping the round-trip with playback.
 *
 * This is the engine behind the previously-cosmetic `ttsStreamingEnabled`
 * toggle. With `prefetch: false` the behavior is byte-identical to the old
 * sequential loop.
 */

export interface ChunkPipelineOptions<A> {
  /** Number of chunks. */
  count: number
  /** Synthesize chunk `i` (e.g. network call). May reject. */
  produce: (index: number) => Promise<A>
  /** Play chunk `i`. Runs strictly in order. May reject. */
  consume: (item: A, index: number) => Promise<void>
  /** Polled before each produce/consume; returning true stops the pipeline. */
  isCancelled: () => boolean
  /** When true, prefetch chunk i+1 while chunk i is being consumed. */
  prefetch: boolean
}

export async function runChunkPipeline<A>(opts: ChunkPipelineOptions<A>): Promise<void> {
  const { count, produce, consume, isCancelled, prefetch } = opts
  if (count <= 0) return

  if (!prefetch) {
    for (let i = 0; i < count; i++) {
      if (isCancelled()) return
      const item = await produce(i)
      if (isCancelled()) return
      await consume(item, i)
    }
    return
  }

  // Keep exactly one synthesis in flight ahead of playback.
  let nextPromise: Promise<A> | null = produce(0)
  try {
    for (let i = 0; i < count; i++) {
      if (isCancelled()) {
        return
      }
      const current = nextPromise as Promise<A>
      const item = await current
      if (isCancelled()) {
        nextPromise = null
        return
      }
      // Start synthesizing i+1 BEFORE playing i so the round-trip overlaps.
      nextPromise = i + 1 < count ? produce(i + 1) : null
      await consume(item, i)
    }
  } finally {
    // A prefetch can outlive a cancel or a consume() throw; swallow its late
    // rejection so it never surfaces as an unhandled promise rejection.
    if (nextPromise) void nextPromise.catch(() => {})
  }
}
