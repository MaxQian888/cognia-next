/**
 * Streaming `/loop` runner for the TUI.
 *
 * Mirrors `goal-run.ts`: an App-level effect (where `agent.send` is in scope)
 * that drives turns through {@link runDrivenTurns}, reusing the `lib/loop`
 * engine wholesale.
 *
 *   - **self_paced** — `getLoopRuntime().createLoop` (redaction + goal/loop
 *     mutex + state) gives the backing row; each turn's reply runs through the
 *     pure `handleLoopTurnComplete` driver, which parses the JSON trailer to
 *     decide continue/stop and the next delay.
 *   - **interval** — a fixed cadence. The desktop maps this onto a scheduler
 *     task, but a TUI session is foreground, so we drive the cadence in-process
 *     (no scheduler task) and stop on the iteration cap or the 7-day expiry.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { Loop } from "@/types/loop"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"
import { DEFAULT_LOOP_CONFIG, getLoopRuntime, LoopGoalConflict } from "@/lib/loop/runtime"
import { handleLoopTurnComplete } from "@/lib/loop/turn-driver"
import { renderLoopIterationMessage } from "@/lib/loop/prompts"
import { LOOP_EXPIRY_MS, MIN_INTERVAL_MS } from "@/lib/loop/interval"
import { getLoop } from "@/lib/db/loops"

import { ensureCliDb } from "../../db/bootstrap"
import { ensureSessionRow } from "../../agent/cli-session-store"
import type { ResolvedConfig } from "../../config/schema"
import { resolveAppSettings } from "./goal-controller"
import { runDrivenTurns, type DrivenAdvance } from "./driven-turns"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface LoopRunDeps {
  send: (prompt: string) => Promise<RunAndCaptureResult | null>
  dispatch: (action: TuiAction) => void
  sessionId: string
  config: ResolvedConfig
  signal: AbortSignal
  mode: "self_paced" | "interval"
  prompt: string
  intervalMs?: number
  maxIterations?: number
  takeSteer?: () => string | null
  // ── injectable seams ──
  ensureDb?: () => Promise<unknown>
  ensureSession?: (sessionId: string, config: ResolvedConfig) => Promise<unknown>
  appSettings?: AppSettings | null
  createLoop?: (input: {
    sessionId: string
    rawPrompt: string
    mode: Loop["mode"]
    config?: Partial<Loop["config"]>
    appSettings: AppSettings | null
  }) => Promise<Loop>
  getLoop?: (id: string) => Promise<Loop | undefined>
  handleTurn?: typeof handleLoopTurnComplete
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

export async function runLoopStreaming(deps: LoopRunDeps): Promise<void> {
  const ensureDb = deps.ensureDb ?? (() => ensureCliDb())
  const ensureSession = deps.ensureSession ?? ensureSessionRow
  await ensureDb()
  await ensureSession(deps.sessionId, deps.config)

  const label = truncate(deps.prompt)
  const common = {
    send: deps.send,
    dispatch: deps.dispatch,
    signal: deps.signal,
    label,
    kind: "loop" as const,
    takeSteer: deps.takeSteer,
    delay: deps.delay,
  }

  if (deps.mode === "interval") {
    await runIntervalLoop(deps, common)
    return
  }
  await runSelfPacedLoop(deps, common)
}

type Common = {
  send: LoopRunDeps["send"]
  dispatch: LoopRunDeps["dispatch"]
  signal: AbortSignal
  label: string
  kind: "loop"
  takeSteer?: () => string | null
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}

async function runSelfPacedLoop(deps: LoopRunDeps, common: Common): Promise<void> {
  const createLoop = deps.createLoop ?? ((input) => getLoopRuntime().createLoop(input))
  const readLoop = deps.getLoop ?? getLoop
  const handleTurn = deps.handleTurn ?? handleLoopTurnComplete
  const appSettings = resolveAppSettings(deps.sessionId, deps.config, deps.appSettings)

  let loop: Loop
  try {
    loop = await createLoop({
      sessionId: deps.sessionId,
      rawPrompt: deps.prompt,
      mode: "self_paced",
      ...(deps.maxIterations !== undefined
        ? { config: { maxIterations: deps.maxIterations } }
        : {}),
      appSettings,
    })
  } catch (err) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary:
        err instanceof LoopGoalConflict
          ? "Loop blocked — an active goal is already driving this session."
          : err instanceof Error
            ? err.message
            : String(err),
    })
    return
  }

  const advance = async ({
    text: lastResponse,
    tokensDelta,
  }: {
    text: string
    tokensDelta: number
  }): Promise<DrivenAdvance> => {
    const current = await readLoop(loop.id)
    if (!current) return { kind: "stop", status: "error", summary: "Loop removed mid-run." }
    const outcome = await handleTurn({
      loopId: loop.id,
      lastResponse,
      tokensDelta,
      signal: deps.signal,
      capturedGenerationId: current.generationId,
    })
    switch (outcome.kind) {
      case "continue":
        return {
          kind: "continue",
          prompt: outcome.userMessage,
          ...(outcome.delayMs ? { delayMs: outcome.delayMs } : {}),
        }
      case "exit":
        return {
          kind: "stop",
          status: outcome.resultingStatus === "error" ? "error" : "done",
          summary: `Loop ${outcome.resultingStatus}: ${outcome.reason}`,
        }
      case "aborted":
        return { kind: "stop", status: "done", summary: "Loop paused." }
      default:
        return {
          kind: "stop",
          status: "error",
          summary: `Loop ${outcome.kind}${"reason" in outcome ? `: ${outcome.reason}` : ""}`,
        }
    }
  }

  await runDrivenTurns({ ...common, firstPrompt: renderLoopIterationMessage(loop), advance })
}

async function runIntervalLoop(deps: LoopRunDeps, common: Common): Promise<void> {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? MIN_INTERVAL_MS
  const cap = deps.maxIterations ?? DEFAULT_LOOP_CONFIG.maxIterations
  const expiresAt = now() + LOOP_EXPIRY_MS
  let completed = 0

  const advance = async (): Promise<DrivenAdvance> => {
    completed += 1
    if (completed >= cap) {
      return {
        kind: "stop",
        status: "done",
        summary: `Loop finished after ${completed} iteration${completed === 1 ? "" : "s"}.`,
      }
    }
    if (now() >= expiresAt) {
      return { kind: "stop", status: "done", summary: "Loop reached its 7-day expiry." }
    }
    return { kind: "continue", prompt: deps.prompt, delayMs: intervalMs }
  }

  await runDrivenTurns({ ...common, firstPrompt: deps.prompt, advance, hardCap: cap + 1 })
}
