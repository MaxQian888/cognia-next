/**
 * Renderer-side recording orchestrator. See ADR-0072.
 *
 * The page buffers element interactions; this owns everything the page cannot:
 *  - Navigation steps. The renderer already tracks `browser://navigated`, so
 *    detecting navigation here keeps one detector instead of two.
 *  - Surviving a navigation. A real navigation destroys the page's JS context,
 *    so this polls the page's buffer on an interval and re-arms on
 *    `browser://loaded` (the page's sessionStorage mirror covers the
 *    same-origin case; this covers cross-origin, where it does not carry over).
 *  - Accumulating across documents into one flow.
 */
import { browserClient } from "@/lib/browser/client"
import { appendStep, type RecordedFlow, type RecordedStep } from "@/lib/browser/recording/protocol"

export interface RecorderOptions {
  /**
   * Injected clock — `Date.now` is lint-banned in this repo, and injecting it
   * also makes the flow's timestamps assertable.
   */
  now: () => number
  /**
   * How often to drain the page's buffer. The page mirrors to sessionStorage on
   * every step, so this is a safety net rather than the primary path; a short
   * interval only narrows the cross-origin loss window.
   */
  pollMs?: number
  /** Fired whenever the accumulated step list changes, for a live step list. */
  onChange?: (steps: RecordedStep[]) => void
}

const DEFAULT_POLL_MS = 400

/**
 * Records one flow at a time. Not reentrant: `start` supersedes any in-flight
 * take.
 */
export class FlowRecorder {
  private steps: RecordedStep[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flow: RecordedFlow | null = null
  /** Orders renderer-minted steps; the page's own `at` counter is per-document. */
  private seq = 0

  constructor(private readonly opts: RecorderOptions) {}

  get recording(): boolean {
    return this.flow !== null
  }

  /** Begin recording at `baseUrl`, which becomes the flow's opening step. */
  async start(baseUrl: string): Promise<void> {
    const at = this.opts.now()
    this.seq = 0
    this.flow = {
      id: `flow_${at}`,
      name: baseUrl,
      baseUrl,
      createdAt: at,
      updatedAt: at,
      steps: [],
    }
    this.steps = [{ act: "navigate", at: this.seq++, url: baseUrl }]
    this.emit()
    await browserClient.embedStartRecord()
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? DEFAULT_POLL_MS)
  }

  /** Drain whatever the page has buffered since the last poll. */
  async poll(): Promise<void> {
    if (!this.flow) return
    let drained: RecordedStep[]
    try {
      drained = await browserClient.embedDrainRecord()
    } catch {
      // The pane can be mid-navigation with no live JS context; the page keeps
      // buffering to sessionStorage, so the next poll picks these up.
      return
    }
    if (!drained.length) return
    for (const step of drained) this.steps = appendStep(this.steps, step)
    this.emit()
  }

  /**
   * Record a navigation reported by `browser://navigated`. Duplicates (a click
   * that navigates reports through both the history hook and the load event)
   * are collapsed by `appendStep`.
   */
  noteNavigation(url: string): void {
    if (!this.flow) return
    this.steps = appendStep(this.steps, { act: "navigate", at: this.seq++, url })
    this.emit()
  }

  /**
   * Handle `browser://loaded`: drain what survived, then re-arm. Draining FIRST
   * matters — on a same-origin navigation the page restored its buffer from
   * sessionStorage, and those steps must be collected before anything else
   * touches the page's state.
   */
  async noteLoaded(): Promise<void> {
    if (!this.flow) return
    await this.poll()
    try {
      await browserClient.embedResumeRecord()
    } catch {
      // A page that cannot be re-armed yields no further steps; the flow keeps
      // what it already has rather than failing the whole take.
    }
  }

  /** Add a human-authored assertion. */
  addAssertion(text: string): void {
    if (!this.flow) return
    this.steps = appendStep(this.steps, { act: "wait_for", at: this.seq++, text })
    this.emit()
  }

  /** Drop a step the user does not want in the flow. */
  removeStep(index: number): void {
    if (!this.flow || index < 0 || index >= this.steps.length) return
    this.steps = this.steps.filter((_, i) => i !== index)
    this.emit()
  }

  /** Stop, take a final drain, and return the finished flow. */
  async stop(): Promise<RecordedFlow | null> {
    if (!this.flow) return null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.poll()
    try {
      await browserClient.embedStopRecord()
    } catch {
      // Best-effort: the take is already in `this.steps`.
    }
    const flow: RecordedFlow = { ...this.flow, steps: this.steps, updatedAt: this.opts.now() }
    this.flow = null
    return flow
  }

  /** Abandon the take without producing a flow. */
  async cancel(): Promise<void> {
    await this.stop()
    this.steps = []
    this.emit()
  }

  /** The steps captured so far, for a live step list. */
  current(): RecordedStep[] {
    return this.steps
  }

  private emit(): void {
    this.opts.onChange?.(this.steps)
  }
}
