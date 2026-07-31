// Action handler for the `/loop` slash command family.
//
// Surface:
//   /loop <prompt>            — self-paced loop: re-runs the prompt; the
//                               model picks each next delay (1 min – 1 hr)
//                               and may end the loop when provably done.
//   /loop 5m <prompt>         — interval loop: fixed cadence via a
//                               session-scoped scheduler task (30s/5m/2h/1d;
//                               seconds round up to 1 minute; 7-day expiry).
//   /loop status              — status card for this session's loop
//   /loop list                — list this session's loops
//   /loop pause | resume      — toggle the open loop
//   /loop stop  (alias: cancel) — stop the open loop
//
// Streaming guard: mutating subcommands bail while a turn is streaming —
// the turn driver may be reading the same row (mirrors `/goal`).
//
// Card strings are hard-coded English, consistent with the existing
// slash-command cards in `actions/goal.ts` (system-message markdown).

import type { SlashContext } from "../builtin"
import { useSettingsStore } from "@/stores/settings"
import { getLoopRuntime, LoopGoalConflict } from "@/lib/loop/runtime"
import { parseInterval } from "@/lib/loop/interval"
import { listLoopEvents } from "@/lib/db/loops"
import type { Loop, LoopEvent } from "@/types/loop"

export interface LoopCommandResult {
  /** Markdown to push into the chat as a system message. */
  system?: string
}

const USAGE = [
  "Usage:",
  "- `/loop <prompt>` — self-paced: the model re-runs the prompt and picks each delay (1 min–1 hr), ending the loop when the task is provably done.",
  "- `/loop 5m <prompt>` — fixed interval (`30s`/`5m`/`2h`/`1d`; seconds round up to 1 minute). Runs as a scheduler task — manage it on the Scheduler page too.",
  "- `/loop status` · `/loop list` · `/loop pause` · `/loop resume` · `/loop stop`",
  "",
  "Every loop expires after 7 days and stops at its iteration cap (default 100).",
].join("\n")

/**
 * Subcommand dispatcher. Returns `null` when the slash dispatcher should
 * fall through (mirrors `dispatchGoalSubcommand`).
 */
export async function dispatchLoopSubcommand(ctx: SlashContext): Promise<LoopCommandResult | null> {
  if (!ctx.activeSessionId) {
    return { system: "Start a chat session first — `/loop` operates inside an active session." }
  }
  const trimmed = (ctx.args ?? "").trim()
  if (!trimmed) return { system: USAGE }

  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()

  switch (head) {
    case "help":
      return { system: USAGE }
    case "status":
      return await commandStatus(ctx)
    case "list":
      return await commandList(ctx)
    case "pause":
      return await guardStreaming(ctx, () => commandPause(ctx))
    case "resume":
      return await guardStreaming(ctx, () => commandResume(ctx))
    case "stop":
    case "cancel":
      return await guardStreaming(ctx, () => commandStop(ctx))
    default: {
      // Leading bare interval token → interval mode; otherwise the whole
      // string is a self-paced prompt.
      const intervalMs = parseInterval(head)
      if (intervalMs !== null) {
        if (!rest) {
          return {
            system: `An interval needs a prompt: \`/loop ${head} <what to do each time>\`.`,
          }
        }
        return await guardStreaming(ctx, () => commandCreateInterval(ctx, intervalMs, rest))
      }
      return await guardStreaming(ctx, () => commandCreateSelfPaced(ctx, trimmed))
    }
  }
}

async function guardStreaming(
  ctx: SlashContext,
  run: () => Promise<LoopCommandResult>
): Promise<LoopCommandResult> {
  if (ctx.chatStatus === "streaming") {
    return {
      system:
        "The current turn is still streaming — `/loop` waits for the response to finish before changing the loop.",
    }
  }
  return run()
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand implementations
// ─────────────────────────────────────────────────────────────────────────────

async function commandCreateSelfPaced(
  ctx: SlashContext,
  prompt: string
): Promise<LoopCommandResult> {
  const sessionId = ctx.activeSessionId!
  const appSettings = useSettingsStore.getState().settings ?? null
  let loop: Loop
  try {
    loop = await getLoopRuntime().createLoop({
      sessionId,
      rawPrompt: prompt,
      mode: "self_paced",
      appSettings,
    })
  } catch (err) {
    if (err instanceof LoopGoalConflict) {
      return {
        system:
          "This session has an active `/goal` driving the turn loop. Stop it first (`/goal stop`) or use an interval loop instead: `/loop 5m <prompt>`.",
      }
    }
    throw err
  }
  // Iteration 1 dispatches through the LoopRuntime kickoff listener — the
  // chat hook sends it silently, same as every later continuation.
  return { system: renderCreatedCard(loop) }
}

async function commandCreateInterval(
  ctx: SlashContext,
  intervalMs: number,
  prompt: string
): Promise<LoopCommandResult> {
  const sessionId = ctx.activeSessionId!
  const appSettings = useSettingsStore.getState().settings ?? null
  const loop = await getLoopRuntime().createLoop({
    sessionId,
    rawPrompt: prompt,
    mode: "interval",
    intervalMs,
    appSettings,
  })
  return { system: renderCreatedCard(loop) }
}

async function commandStatus(ctx: SlashContext): Promise<LoopCommandResult> {
  const loop = await getLoopRuntime().getOpenLoopForSession(ctx.activeSessionId!)
  if (!loop) {
    return { system: "No loop in this session. Start one with `/loop <prompt>`." }
  }
  const events = await listLoopEvents(loop.id, 10)
  return { system: renderStatusCard(loop, events) }
}

async function commandList(ctx: SlashContext): Promise<LoopCommandResult> {
  const loops = await getLoopRuntime().listLoopsBySession(ctx.activeSessionId!)
  if (loops.length === 0) {
    return { system: "No loops in this session yet. Start one with `/loop <prompt>`." }
  }
  const lines = ["🔁 **Loops in this session:**", ""]
  for (const loop of loops.slice(0, 8)) {
    const mode = loop.mode === "interval" ? `every ${formatMs(loop.intervalMs ?? 0)}` : "self-paced"
    lines.push(
      `- ${statusEmoji(loop.status)} \`${loop.status}\` · ${mode} · ${loop.iterations} iteration(s) — ${truncate(loop.safePrompt, 60)}`
    )
  }
  lines.push("", "Interval loops also appear on the Scheduler page under the **Loop** filter.")
  return { system: lines.join("\n") }
}

async function commandPause(ctx: SlashContext): Promise<LoopCommandResult> {
  const loop = await getLoopRuntime().getOpenLoopForSession(ctx.activeSessionId!)
  if (!loop) return { system: "No loop to pause." }
  if (loop.status !== "active") {
    return { system: `Loop is already ${loop.status} — nothing to pause.` }
  }
  await getLoopRuntime().pauseLoop(loop.id)
  return { system: "Loop paused. Resume with `/loop resume`." }
}

async function commandResume(ctx: SlashContext): Promise<LoopCommandResult> {
  const loop = await getLoopRuntime().getOpenLoopForSession(ctx.activeSessionId!)
  if (!loop) return { system: "No loop to resume." }
  if (loop.status === "active") return { system: "Loop is already active." }
  if (loop.status !== "paused") {
    return {
      system: `Cannot resume a ${loop.status} loop. Start a new one with \`/loop <prompt>\`.`,
    }
  }
  await getLoopRuntime().resumeLoop(loop.id)
  // Self-paced resumes kick the next iteration via the runtime's kickoff
  // listener; interval loops wait for their next scheduler fire.
  return {
    system:
      loop.mode === "self_paced"
        ? "Loop resumed — next iteration dispatching."
        : "Loop resumed. The next interval fire will continue it.",
  }
}

async function commandStop(ctx: SlashContext): Promise<LoopCommandResult> {
  const loop = await getLoopRuntime().getOpenLoopForSession(ctx.activeSessionId!)
  if (!loop) return { system: "No loop to stop." }
  await getLoopRuntime().stopLoop(loop.id)
  return { system: `Loop stopped after ${loop.iterations} iteration(s).` }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderCreatedCard(loop: Loop): string {
  const cadence =
    loop.mode === "interval"
      ? `every ${formatMs(loop.intervalMs ?? 0)} (scheduler-backed — also on the Scheduler page under the **Loop** filter)`
      : "self-paced — the model picks each delay (1 min–1 hr) and ends the loop when provably done"
  return [
    `🔁 **Loop active** — ${cadence}.`,
    "",
    `> ${loop.safePrompt}`,
    "",
    `Caps: ${loop.config.maxIterations} iterations · 7-day expiry. Pause with \`/loop pause\` · stop with \`/loop stop\`.`,
  ].join("\n")
}

function renderStatusCard(loop: Loop, events: LoopEvent[]): string {
  const minutesElapsed = Math.round((Date.now() - loop.createdAt) / 60_000)
  const mode = loop.mode === "interval" ? `every ${formatMs(loop.intervalMs ?? 0)}` : "self-paced"
  const lines = [
    `🔁 **${statusEmoji(loop.status)} ${loop.status.toUpperCase()}** — ${mode} · ${loop.iterations}/${loop.config.maxIterations} iterations · ${minutesElapsed}m elapsed`,
    "",
    `> ${loop.safePrompt}`,
  ]
  if (loop.mode === "self_paced" && loop.nextDelayMs) {
    lines.push(
      "",
      `Next iteration ~${formatMs(loop.nextDelayMs)} after the last${loop.nextDelayReason ? ` — _${loop.nextDelayReason}_` : ""}.`
    )
  }
  if (events.length > 0) {
    lines.push("", "**Recent activity:**")
    for (const ev of events.slice(0, 5)) {
      lines.push(`- \`${ev.kind}\` at ${new Date(ev.ts).toLocaleTimeString()}`)
    }
  }
  return lines.join("\n")
}

function statusEmoji(status: Loop["status"]): string {
  switch (status) {
    case "active":
      return "🟢"
    case "paused":
      return "⏸️"
    case "completed":
      return "✅"
    case "stopped":
      return "⏹️"
    case "iteration_limited":
    case "budget_limited":
    case "expired":
      return "🛑"
    case "error":
      return "⚠️"
    default:
      return "•"
  }
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1_000)}s`
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}
