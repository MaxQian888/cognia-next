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

export interface RecordingDriver {
  start(): Promise<unknown>
  resume(): Promise<unknown>
  stop(): Promise<unknown>
  drain(): Promise<RecordedStep[]>
}

const embeddedRecordingDriver: RecordingDriver = {
  start: () => browserClient.embedStartRecord(),
  resume: () => browserClient.embedResumeRecord(),
  stop: () => browserClient.embedStopRecord(),
  drain: () => browserClient.embedDrainRecord(),
}

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
  /** Host adapter; defaults to the desktop embedded webview. */
  driver?: RecordingDriver
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
  private failure: Error | null = null
  /** Orders renderer-minted steps; the page's own `at` counter is per-document. */
  private seq = 0

  constructor(private readonly opts: RecorderOptions) {}

  private get driver(): RecordingDriver {
    return this.opts.driver ?? embeddedRecordingDriver
  }

  get recording(): boolean {
    return this.flow !== null
  }

  /** Begin recording at `baseUrl`, which becomes the flow's opening step. */
  async start(baseUrl: string): Promise<void> {
    if (this.recording) await this.cancel()
    this.failure = null
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
    try {
      await this.driver.start()
    } catch (error) {
      this.flow = null
      this.steps = []
      this.emit()
      throw error
    }
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? DEFAULT_POLL_MS)
  }

  /** Drain whatever the page has buffered since the last poll. */
  async poll(): Promise<void> {
    if (!this.flow || this.failure) return
    let drained: RecordedStep[]
    try {
      drained = await this.driver.drain()
    } catch (error) {
      // The pane can be mid-navigation with no live JS context; the embedded
      // buffer or Chromium host journal is drained by the next poll.
      this.rememberPermanentFailure(error)
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
      await this.driver.resume()
    } catch (error) {
      // A page that cannot be re-armed yields no further steps; the flow keeps
      // what it already has. A permanent failure prevents exporting a
      // successful-looking partial take at stop.
      this.rememberPermanentFailure(error)
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
      await this.driver.stop()
    } catch (error) {
      this.rememberPermanentFailure(error)
    }
    const flow: RecordedFlow = { ...this.flow, steps: this.steps, updatedAt: this.opts.now() }
    this.flow = null
    if (this.failure) throw this.failure
    return flow
  }

  /** Abandon the take without producing a flow. */
  async cancel(): Promise<void> {
    try {
      await this.stop()
    } catch {
      // Cancel explicitly abandons the take, including its failure.
    } finally {
      this.steps = []
      this.failure = null
      this.emit()
    }
  }

  /** The steps captured so far, for a live step list. */
  current(): RecordedStep[] {
    return this.steps
  }

  private emit(): void {
    this.opts.onChange?.(this.steps)
  }

  private rememberPermanentFailure(error: unknown): void {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (
      error instanceof SyntaxError ||
      (typeof code === "string" &&
        (code.startsWith("browser_recording_") ||
          code === "browser_human_input_required" ||
          code === "browser_feature_unsupported"))
    ) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    }
  }
}
