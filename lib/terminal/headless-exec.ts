"use client"

/**
 * Policy entry point for *unattended* terminal execution — the shared
 * seam workflow terminal nodes (and, later, agent tools) call to run a
 * shell command headlessly: no visible dock tab, no per-command human
 * consent. The `classifyCommand` safety verdict replaces the human gate:
 *
 *   1. `settings.terminal.allowUnattendedExecution` is the master switch
 *      — off (the default) fails closed.
 *   2. `deny` verdicts never run, regardless of any policy.
 *   3. `allow` verdicts run on the active host execution backend: the
 *      companion `terminal_exec` RPC in brain, or the desktop
 *      `terminal_headless_exec` / `terminal_headless_run` commands.
 *   4. `ask` verdicts follow the effective ask-policy
 *      (`input.onAskVerdict` → `settings.terminal.unattendedAskPolicy` →
 *      `"fail"`): fail the step, fall back to the visible-dock consent
 *      path, or run anyway (explicit trust-my-workflow opt-in).
 *
 * Every executed AND every blocked unattended command lands in the
 * durable `unattendedExecAudit` table.
 */

import { classifyCommand } from "@/lib/claude/permissions/command-safety"
import { useSettingsStore } from "@/stores/settings"

export type UnattendedAskPolicy = "fail" | "consent" | "run"

export interface HeadlessExecInput {
  command: string
  cwd?: string
  shell?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Per-call override of `settings.terminal.unattendedAskPolicy`. */
  onAskVerdict?: UnattendedAskPolicy
  /** Required for the `consent` fallback (scopes the dock trust grant). */
  chatSessionId?: string
  /** Run inside an existing persistent headless session. */
  sessionId?: string
  /** Audit context. */
  runId?: string
  source?: "workflow" | "agent"
}

export type HeadlessExecOutcome =
  | {
      ok: true
      exitCode: number | null
      output: string
      durationMs: number
      timedOut: boolean
      /** The classifier verdict the command ran under. */
      verdict: "allow" | "ask"
      /** True when the `consent` policy routed through the visible dock. */
      viaConsent?: boolean
    }
  | { ok: false; reason: string; verdict?: "allow" | "ask" | "deny" }

interface RustHeadlessResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

interface ServerExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

function readTerminalSettings() {
  return useSettingsStore.getState().settings?.terminal
}

/** Fire-and-forget audit append — auditing must never fail the run. */
function audit(row: {
  command: string
  verdict: "allow" | "ask" | "deny"
  reason: string
  blocked: boolean
  source: "workflow" | "agent"
  runId?: string
  exitCode?: number | null
  durationMs?: number
}): void {
  void (async () => {
    const { appendUnattendedExecAudit } = await import("@/lib/db/terminal-audit")
    await appendUnattendedExecAudit(row)
  })().catch(() => {})
}

/** Run one command line under the unattended-execution policy. */
export async function runHeadlessExec(input: HeadlessExecInput): Promise<HeadlessExecOutcome> {
  const command = input.command?.trim()
  if (!command) {
    return { ok: false, reason: "command is required" }
  }
  const source = input.source ?? "workflow"
  const terminal = readTerminalSettings()

  // 1. Master switch — fail closed.
  if (terminal?.allowUnattendedExecution !== true) {
    return {
      ok: false,
      reason:
        "unattended terminal execution is disabled (settings.terminal.allowUnattendedExecution)",
    }
  }

  // 2-4. Safety classifier replaces the human gate.
  const classified = classifyCommand(command)
  if (classified.verdict === "deny") {
    audit({
      command,
      verdict: "deny",
      reason: classified.reason,
      blocked: true,
      source,
      runId: input.runId,
    })
    return {
      ok: false,
      reason: `blocked by the command safety classifier: ${classified.reason}`,
      verdict: "deny",
    }
  }

  if (classified.verdict === "ask") {
    const policy: UnattendedAskPolicy = input.onAskVerdict ?? terminal.unattendedAskPolicy ?? "fail"
    if (policy === "fail") {
      audit({
        command,
        verdict: "ask",
        reason: classified.reason,
        blocked: true,
        source,
        runId: input.runId,
      })
      return {
        ok: false,
        reason: `command requires confirmation (${classified.reason}); unattended ask-policy is "fail"`,
        verdict: "ask",
      }
    }
    if (policy === "consent") {
      return runViaDockConsent(input, command, classified.reason, source)
    }
    // policy === "run" — explicit opt-in, fall through to headless exec.
  }

  return execHeadless(input, command, classified.verdict as "allow" | "ask", source)
}

/**
 * The `consent` ask-policy: delegate to the visible-dock consent path
 * (`runTerminalDockAction` — same gate + trust broker the chat affordance
 * and the agent's terminal_dock_* tools use).
 */
async function runViaDockConsent(
  input: HeadlessExecInput,
  command: string,
  reason: string,
  source: "workflow" | "agent"
): Promise<HeadlessExecOutcome> {
  if (!input.chatSessionId) {
    return {
      ok: false,
      reason: `command requires confirmation (${reason}); the consent fallback needs a chat session`,
      verdict: "ask",
    }
  }
  const { runTerminalDockAction } = await import("./dock-tool-handler")
  const result = await runTerminalDockAction({
    chatSessionId: input.chatSessionId,
    action: "spawn",
    args: {
      command,
      cwd: input.cwd,
      shell: input.shell,
      timeoutSec: input.timeoutMs ? Math.ceil(input.timeoutMs / 1000) : undefined,
    },
  })
  if (!result.ok) {
    audit({
      command,
      verdict: "ask",
      reason: `${reason} (dock consent path: ${result.reason})`,
      blocked: true,
      source,
      runId: input.runId,
    })
    return { ok: false, reason: result.reason, verdict: "ask" }
  }
  if ("records" in result) {
    // Unreachable for the spawn action — narrow defensively.
    return { ok: false, reason: "unexpected dock result shape", verdict: "ask" }
  }
  audit({
    command,
    verdict: "ask",
    reason: `${reason} (ran via dock consent)`,
    blocked: false,
    source,
    runId: input.runId,
    exitCode: result.exitCode ?? null,
  })
  return {
    ok: true,
    exitCode: result.exitCode ?? null,
    output: result.output ?? "",
    durationMs: 0,
    timedOut: false,
    verdict: "ask",
    viaConsent: true,
  }
}

/** Execute on the host backend. */
async function execHeadless(
  input: HeadlessExecInput,
  command: string,
  verdict: "allow" | "ask",
  source: "workflow" | "agent"
): Promise<HeadlessExecOutcome> {
  const { isHeadlessHost } = await import("@/lib/platform/detect")
  if (isHeadlessHost()) {
    return execOnHeadlessServer(input, command, verdict, source)
  }

  const { isTauri } = await import("@/lib/tauri")
  if (!isTauri()) {
    return { ok: false, reason: "headless terminal execution requires the desktop app" }
  }
  const { invoke } = await import("@tauri-apps/api/core")
  let result: RustHeadlessResult
  try {
    if (input.sessionId) {
      result = (await invoke("terminal_headless_run", {
        sessionId: input.sessionId,
        command,
        timeoutMs: input.timeoutMs,
      })) as RustHeadlessResult
    } else {
      // ADR-0028 Phase 3.3 — a fresh one-shot headless shell honors the
      // global sandbox toggle (persistent `terminal_headless_run` reuses the
      // policy the session was spawned with, so it isn't re-passed here).
      const { useSettingsStore } = await import("@/stores/settings")
      const sandboxed = useSettingsStore.getState().settings?.terminal?.sandboxed ?? false
      result = (await invoke("terminal_headless_exec", {
        command,
        cwd: input.cwd,
        shell: input.shell,
        env: input.env,
        timeoutMs: input.timeoutMs,
        sandboxed,
      })) as RustHeadlessResult
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message, verdict }
  }

  audit({
    command,
    verdict,
    reason: verdict === "ask" ? 'ask verdict ran under policy "run"' : "allowed by classifier",
    blocked: false,
    source,
    runId: input.runId,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  })

  if (result.timedOut) {
    return {
      ok: true,
      exitCode: null,
      output: result.output,
      durationMs: result.durationMs,
      timedOut: true,
      verdict,
    }
  }
  return {
    ok: true,
    exitCode: result.exitCode,
    output: result.output,
    durationMs: result.durationMs,
    timedOut: false,
    verdict,
  }
}

async function execOnHeadlessServer(
  input: HeadlessExecInput,
  command: string,
  verdict: "allow" | "ask",
  source: "workflow" | "agent"
): Promise<HeadlessExecOutcome> {
  const reject = (reason: string): HeadlessExecOutcome => {
    audit({
      command,
      verdict,
      reason,
      blocked: true,
      source,
      runId: input.runId,
    })
    return { ok: false, reason, verdict }
  }

  if (input.sessionId) {
    return reject(
      "persistent headless terminal sessions are unavailable on the server execution plane"
    )
  }

  const sandboxed = readTerminalSettings()?.sandboxed ?? false
  if (sandboxed) {
    return reject("sandboxed headless execution is unavailable on the server execution plane")
  }
  if (input.shell?.trim()) {
    return reject("custom shells are unavailable on the server execution plane")
  }

  const { transport } = await import("@/lib/tauri")
  const startedAt = Date.now()
  let result: ServerExecResult
  try {
    result = await transport.call<ServerExecResult>("terminal_exec", {
      command,
      args: [],
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      shell: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message, verdict }
  }

  const durationMs = Date.now() - startedAt
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
  audit({
    command,
    verdict,
    reason: verdict === "ask" ? 'ask verdict ran under policy "run"' : "allowed by classifier",
    blocked: false,
    source,
    runId: input.runId,
    exitCode: result.exitCode,
    durationMs,
  })

  return {
    ok: true,
    exitCode: result.timedOut ? null : result.exitCode,
    output,
    durationMs,
    timedOut: result.timedOut,
    verdict,
  }
}
