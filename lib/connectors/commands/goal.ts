/**
 * Connector-side `/goal` handling (ADR-0019 → IM inbound).
 *
 * An inbound `/goal <sub> …` control command is routed here from
 * `commands/dispatch.ts` (Step 9.5). We reuse the shared slash-action
 * `dispatchGoalSubcommand` (create/status/show/pause/resume/stop/update, plus
 * the stop aliases) so the subcommand grammar + card copy stay identical to the
 * desktop composer. Because an IM session has no chat hook to pump the loop, we
 * then start a HEADLESS driver (`runGoalLoopHeadless`) that runs each turn and
 * posts its reply back to the conversation via `enqueueOutbound`.
 *
 * Guard: the v49 `allowGoalDriving` opt-in is enforced inside
 * `GoalRuntime.createGoal`, which throws `GoalImBlocked` for an IM-bound
 * session that hasn't opted in — mapped here to a bilingual "enable it in the
 * app" reply.
 *
 * Availability: this runs wherever the connector runtime runs — desktop (all
 * channels) and `cli serve` (webhook-transport channels only). The Capacitor
 * mobile shell has no connector runtime, so IM goals are desktop/CLI-only.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { Goal } from "@/types/goal"
import type { SlashContext } from "@/lib/slash-commands/builtin"
import { isTerminalGoalStatus } from "@/types/goal"
import { getGoalRuntime, GoalImBlocked } from "@/lib/goal/runtime"
import { dispatchGoalSubcommand, type GoalCommandResult } from "@/lib/slash-commands/actions/goal"
import { runGoalLoopHeadless } from "@/lib/scheduler/executors/goal-headless-runner"
import { safeSendPrompt } from "@/lib/connectors/ai-loop/safe-send-prompt"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
import { hasNoLeakingPii } from "@cognia/redact"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { useSettingsStore } from "@/stores/settings"
import { renderGoalBlocked, renderGoalUsage } from "./render"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

type ReplyKind = "applied" | "denied" | "unknown"
type ReplyFn = (text: string, kind: ReplyKind, extra?: Record<string, unknown>) => Promise<void>

export interface HandleGoalCommandInput {
  event: NormalizedInboundEvent
  /** Text after the `/goal` token (the subcommand + its argument). */
  arg: string
  /** Resolve (creating if needed) the conversation's active session. */
  ensureSession: () => Promise<ChatSession>
  /** Post a confirmation back to the conversation (shared with dispatch.ts). */
  reply: ReplyFn
  deps?: GoalCommandDeps
}

export interface GoalCommandDeps {
  dispatch?: typeof dispatchGoalSubcommand
  getOpenGoal?: (sessionId: string) => Promise<Goal | undefined>
  startDriver?: (args: ConnectorGoalDriverArgs) => void
  appSettings?: AppSettings | null
}

/**
 * Route one inbound `/goal …` command: apply it via the shared slash action,
 * reply, and — when it left an active goal — ensure a headless driver is
 * running for it.
 */
export async function handleGoalCommand(input: HandleGoalCommandInput): Promise<void> {
  const { event, arg, ensureSession, reply } = input
  const dispatch = input.deps?.dispatch ?? dispatchGoalSubcommand
  const getOpenGoal =
    input.deps?.getOpenGoal ?? ((id: string) => getGoalRuntime().getOpenGoalForSession(id))
  const startDriver = input.deps?.startDriver ?? startConnectorGoalDriver
  const appSettings = input.deps?.appSettings ?? useSettingsStore.getState().settings ?? null

  const session = await ensureSession()
  const ctx = makeInertSlashContext(arg, session.id)

  let result: GoalCommandResult | null
  try {
    result = await dispatch(ctx)
  } catch (err) {
    if (err instanceof GoalImBlocked) {
      await reply(renderGoalBlocked(), "denied", { reason: "goal_im_blocked" })
      return
    }
    throw err
  }

  await reply(result?.system ?? renderGoalUsage(), "applied")

  // An IM session has no chat hook, so ensure a headless driver is pumping any
  // active goal. `startConnectorGoalDriver` is idempotent (one per goalId), so
  // this is safe to call on every command — it also self-heals a goal left
  // active with no live driver (e.g. after a runtime restart).
  const goal = await getOpenGoal(session.id)
  if (goal?.status === "active") {
    startDriver({
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      conversationRef: event.conversationRef,
      sessionId: session.id,
      goalId: goal.id,
      appSettings,
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Headless driver — one per active goal, owned by the connector runtime.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectorGoalDriverArgs {
  adapterId: string
  conversationKey: string
  conversationRef: NormalizedInboundEvent["conversationRef"]
  sessionId: string
  goalId: string
  appSettings: AppSettings | null
}

export interface ConnectorGoalDriverDeps {
  run?: typeof runGoalLoopHeadless
  enqueue?: typeof enqueueOutbound
  signal?: AbortSignal
}

/** Goal ids with a live driver — guards against double-driving one goal. */
const runningDrivers = new Set<string>()

/**
 * Start (idempotently) a headless driver for `goalId`. Each completed turn's
 * assistant text is posted back to the conversation; the loop honors the
 * pacing gate (quiet-hours / interval / manual-hold) and exits on any terminal
 * or externally-paused status.
 */
export function startConnectorGoalDriver(
  args: ConnectorGoalDriverArgs,
  deps: ConnectorGoalDriverDeps = {}
): void {
  if (runningDrivers.has(args.goalId)) return
  runningDrivers.add(args.goalId)

  const run = deps.run ?? runGoalLoopHeadless
  const enqueue = deps.enqueue ?? enqueueOutbound
  const controller = new AbortController()
  const signal = deps.signal ?? controller.signal

  const post = async (text: string): Promise<unknown> => {
    if (!hasNoLeakingPii(text)) {
      await appendAudit({
        adapterId: args.adapterId,
        kind: "adapter.error",
        at: Date.now(),
        conversationKey: args.conversationKey,
        reason: "pii_blocked",
        message: "connector goal output rejected by PII gate before enqueue",
      })
      throw new Error("Connector goal output blocked by PII gate")
    }
    return enqueue({
      adapterId: args.adapterId,
      conversationKey: args.conversationKey,
      request: {
        conversationRef: args.conversationRef,
        segments: [{ type: "text", text }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      },
      source: "ai-run",
    })
  }

  void (async () => {
    try {
      const result = await run({
        sessionId: args.sessionId,
        goalId: args.goalId,
        appSettings: args.appSettings,
        signal,
        sendTurn: (sessionId, prompt, options, captureOptions) =>
          safeSendPrompt(sessionId, prompt, options, {
            ...captureOptions,
            adapterId: args.adapterId,
            conversationKey: args.conversationKey,
          }),
        onTurn: async (text) => {
          if (text.trim()) await post(text)
        },
        pacing: { enabled: true },
      })
      if (isTerminalGoalStatus(result.status)) {
        await post(
          `🎯 目标已${result.status} / Goal ${result.status} — ${result.turns} 回合 / turn(s).`
        ).catch(() => undefined)
      }
    } catch (err) {
      log?.warn?.("Connector goal driver failed", {
        goalId: args.goalId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      runningDrivers.delete(args.goalId)
    }
  })()
}

/** True when a driver is currently running for `goalId` (test/observability). */
export function isConnectorGoalDriverRunning(goalId: string): boolean {
  return runningDrivers.has(goalId)
}

/** Clears the running-driver registry — tests only. */
export function __resetConnectorGoalDriversForTesting(): void {
  runningDrivers.clear()
}

/**
 * Build a slash context for headless `/goal` dispatch. The goal action reads
 * only `args` / `activeSessionId` / `chatStatus`; the interactive-composer
 * callbacks (`startNewSession`, `openSettings`, `setPermissionMode`,
 * `pushSystemMessage`) are inert no-ops here — there is no composer to drive.
 */
function makeInertSlashContext(args: string, sessionId: string): SlashContext {
  const noop = () => {}
  return {
    args,
    activeSessionId: sessionId,
    chatStatus: "idle",
    currentPermissionMode: null,
    startNewSession: noop,
    openSettings: noop,
    setPermissionMode: noop,
    pushSystemMessage: noop,
  }
}

export const __testing__ = { makeInertSlashContext }
