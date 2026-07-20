/**
 * Replay a {@link RecordedFlow} against the embedded preview. See ADR-0072.
 *
 * This adds no engine: it drives the existing `BrowserEngine` (ADR-0055) and
 * keeps its discipline — every step resolves its recorded selector to a live
 * snapshot `ref` and acts by ref, because refs are minted per snapshot
 * `generation` and cannot be recorded ahead of time.
 */
import type { BrowserEngine } from "@/lib/browser/agent-engine"
import { browserClient } from "@/lib/browser/client"
import {
  resolveStepUrl,
  secretKey,
  type RecordedFlow,
  type RecordedStep,
  type RecordedTarget,
} from "@/lib/browser/recording/protocol"

export interface ReplayStepResult {
  index: number
  step: RecordedStep
  ok: boolean
  /** Human-readable failure reason; null on success. */
  error: string | null
}

export interface ReplayResult {
  ok: boolean
  steps: ReplayStepResult[]
}

export interface ReplayOptions {
  /**
   * Values for the flow's secret fields, keyed by {@link secretKey}. Recording
   * never captures a password, so replaying a login requires these; a missing
   * key fails the step loudly rather than silently typing an empty string into
   * a credential field.
   */
  secrets?: Record<string, string>
  /** Progress callback, fired once per step as it settles. */
  onStep?: (result: ReplayStepResult) => void
  /** Abort between steps (the pane's Stop button). */
  signal?: AbortSignal
  /** How long a `wait_for` assertion may block. */
  waitTimeoutMs?: number
}

/** Settle the document after an action that may or may not have navigated. */
const SETTLE_MS = 3000

class StepError extends Error {}

async function resolveRef(target: RecordedTarget): Promise<string> {
  const ref = await browserClient.embedRefFor(target.selector)
  if (!ref) throw new StepError(`no element matches ${target.selector}`)
  return ref
}

async function act(
  engine: BrowserEngine,
  target: RecordedTarget,
  action: string,
  args: Record<string, unknown> = {}
): Promise<void> {
  const ref = await resolveRef(target)
  const result = await engine.act(ref, action, args)
  if (!result.ok) throw new StepError(result.error ?? `${action} failed`)
}

function secretValue(target: RecordedTarget, secrets: Record<string, string>): string {
  const key = secretKey(target)
  const value = secrets[key]
  if (value == null) {
    throw new StepError(`missing secret "${key}" — provide it before replaying this flow`)
  }
  return value
}

async function runStep(
  flow: RecordedFlow,
  engine: BrowserEngine,
  step: RecordedStep,
  opts: ReplayOptions
): Promise<void> {
  switch (step.act) {
    case "navigate": {
      const url = resolveStepUrl(flow, step.url)
      await engine.navigate(url)
      await engine.waitForLoad({ targetUrl: url })
      return
    }
    case "click": {
      await act(
        engine,
        step.target,
        "click",
        step.modifiers?.length ? { modifiers: step.modifiers } : {}
      )
      // The click may have navigated; settle so the next step resolves its
      // selector against the document this click produced, not the old one.
      await engine.waitForLoad({ timeoutMs: SETTLE_MS })
      return
    }
    case "double_click": {
      await act(
        engine,
        step.target,
        "double_click",
        step.modifiers?.length ? { modifiers: step.modifiers } : {}
      )
      await engine.waitForLoad({ timeoutMs: SETTLE_MS })
      return
    }
    case "hover": {
      await act(engine, step.target, "hover")
      return
    }
    case "scroll": {
      const result = await engine.scroll({ direction: step.direction, amount: step.amount })
      if (!result.ok) throw new StepError(result.error ?? `scroll ${step.direction} failed`)
      return
    }
    case "fill": {
      const value = step.secret ? secretValue(step.target, opts.secrets ?? {}) : step.value
      // `fill` takes `text`, not `value`: that is what the overlay reads
      // (`performAct` in overlay.injected.js) and what the canonical tool
      // contract sends (`browser_fill_form` → `{ text }`). The overlay coerces a
      // missing `text` to "" and still returns ok, so getting this name wrong is
      // a silent no-op, not an error. The arg names are per action, not uniform.
      await act(engine, step.target, "fill", { text: value })
      return
    }
    case "select": {
      // `select` genuinely reads `args.value` — see the note on `fill` above.
      await act(engine, step.target, "select", { value: step.value })
      return
    }
    case "press_key": {
      const ref = step.target ? await resolveRef(step.target) : undefined
      const result = await engine.pressKey(step.key, ref)
      if (!result.ok) throw new StepError(result.error ?? `press ${step.key} failed`)
      await engine.waitForLoad({ timeoutMs: SETTLE_MS })
      return
    }
    case "wait_for": {
      const res = await engine.waitForText(step.text, { timeoutMs: opts.waitTimeoutMs ?? 5000 })
      if (!res.ok) throw new StepError(`timed out waiting for "${step.text}"`)
      return
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run every step in order, stopping at the first failure — a flow is a
 * sequence, so continuing past a broken step would report cascading failures
 * that all trace back to the first one.
 */
export async function replayFlow(
  flow: RecordedFlow,
  engine: BrowserEngine,
  opts: ReplayOptions = {}
): Promise<ReplayResult> {
  const steps: ReplayStepResult[] = []
  for (const [index, step] of flow.steps.entries()) {
    if (opts.signal?.aborted) {
      const aborted: ReplayStepResult = { index, step, ok: false, error: "replay stopped" }
      steps.push(aborted)
      opts.onStep?.(aborted)
      return { ok: false, steps }
    }
    let result: ReplayStepResult
    try {
      await runStep(flow, engine, step, opts)
      result = { index, step, ok: true, error: null }
    } catch (error) {
      result = { index, step, ok: false, error: messageOf(error) }
    }
    steps.push(result)
    opts.onStep?.(result)
    if (!result.ok) return { ok: false, steps }
  }
  return { ok: true, steps }
}
