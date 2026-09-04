/**
 * One clock for every repeating animation in the TUI.
 *
 * Each `ink-spinner` used to own a `setInterval`, so a turn with four running
 * tool cards ran four timers whose phases depended on when each card mounted:
 * the spinners in a single column visibly chased each other. Subscribers here
 * share one timer per interval and read the same tick, so everything animating
 * at the same cadence animates in step.
 *
 * The timer is unreferenced where the runtime allows it, so a component that
 * outlives its test (or a frame pending at shutdown) can never hold the process
 * open. The counter restarts once the last subscriber leaves, so an animation
 * always begins at its first frame rather than mid-cycle.
 */

type Listener = (tick: number) => void

interface Channel {
  handle: ReturnType<typeof setInterval>
  tick: number
  listeners: Set<Listener>
}

export class AnimationClock {
  private readonly channels = new Map<number, Channel>()

  /** Current frame for a cadence, or 0 when nothing is animating at it. */
  tick(intervalMs: number): number {
    return this.channels.get(intervalMs)?.tick ?? 0
  }

  /** Number of live timers. Exposed so tests can prove the clock is shared. */
  get timerCount(): number {
    return this.channels.size
  }

  /** Listen to a cadence. Returns the unsubscribe. */
  subscribe(intervalMs: number, listener: Listener): () => void {
    const existing = this.channels.get(intervalMs)
    if (existing) {
      existing.listeners.add(listener)
      return () => this.release(intervalMs, listener)
    }
    const channel: Channel = {
      handle: setInterval(() => {
        const live = this.channels.get(intervalMs)
        if (!live) return
        live.tick += 1
        for (const l of [...live.listeners]) l(live.tick)
      }, intervalMs),
      tick: 0,
      listeners: new Set([listener]),
    }
    // Node's timer object carries `unref`. A browser/jsdom timer id does not.
    const handle = channel.handle as unknown as { unref?: () => void }
    handle.unref?.()
    this.channels.set(intervalMs, channel)
    return () => this.release(intervalMs, listener)
  }

  private release(intervalMs: number, listener: Listener): void {
    const channel = this.channels.get(intervalMs)
    if (!channel) return
    channel.listeners.delete(listener)
    if (channel.listeners.size > 0) return
    clearInterval(channel.handle)
    this.channels.delete(intervalMs)
  }

  /** Stop every timer. For test teardown, never for production code. */
  stopAll(): void {
    for (const channel of this.channels.values()) clearInterval(channel.handle)
    this.channels.clear()
  }
}

/** The process-wide clock every animated component subscribes to. */
export const animationClock = new AnimationClock()
