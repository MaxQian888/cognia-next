/**
 * Runtime hook runner — the bridge between the live turn and the committed hook
 * engine core (`cli/src/hooks/*`). It loads the merged cognia + `.claude` hook
 * config once, then:
 *
 * - `onCapture(event)` classifies a stream event (PostToolUse / PostCompact) and
 *   fires its matching command handlers (observational, fire-and-forget).
 * - `onStop(ok)` fires `Stop` / `StopFailure` at turn end.
 * - `onPrompt(text)` fires `UserPromptSubmit` before a turn (observational here).
 * - `preToolUse(tool, input)` fires `PreToolUse` and AWAITS a deny decision, so a
 *   non-zero-exit guard command can block an approval-gated tool.
 *
 * The shell spawn + file read are injected so this unit-tests without disk or a
 * real subprocess. Only `command` handlers run (mirrors the desktop Phase 1 and
 * the committed `run-hooks` core); webhook / other handlers are inert.
 */
import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { classifyEvent } from "../../hooks/classify"
import { loadHooks, type FileReader } from "../../hooks/load-hooks"
import { runHooks } from "../../hooks/run-hooks"
import type { HookEvent, HooksConfig } from "../../hooks/types"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { buildBuiltinHookGroups, type BuiltinHookOverrides } from "@/lib/claude/hooks/builtin-hooks"

export interface HookRunnerDeps {
  /** Cognia config home (`~/.cognia`). */
  home: string
  /** OS home (`~`) — `~/.claude/settings.json` hangs off this. */
  osHome?: string
  spawn?: typeof nodeSpawn
  readFile?: FileReader
  /**
   * Absolute path to the bundled `hooks/builtin/` dir. Defaults to
   * `<cwd>/hooks/builtin`. When the dir is absent the command hooks simply
   * fail-soft at spawn, so a wrong path never locks the user out.
   */
  builtinHooksDir?: string
  /** Per-id enable/disable overrides for the built-in hooks. */
  builtinHookOverrides?: BuiltinHookOverrides
}

export interface PreToolHookDecision {
  deny: boolean
  reason?: string
}

export interface HookRunner {
  /** Classify + fire lifecycle hooks for one capture event (fire-and-forget). */
  onCapture(event: CaptureStreamEvent): void
  /** Fire `Stop` / `StopFailure` at turn end (fire-and-forget). */
  onStop(ok: boolean): void
  /** Fire `UserPromptSubmit` before a turn (fire-and-forget). */
  onPrompt(prompt: string): void
  /** Fire `PreToolUse` and await a deny decision for an approval-gated tool. */
  preToolUse(toolName: string, input: unknown): Promise<PreToolHookDecision>
  /** Fire `SessionStart` when a chat session begins (mount / `/clear` / `/resume`). */
  onSessionStart(sessionId: string): void
  /** Fire `SessionEnd` when a session is torn down (`/clear`, exit). */
  onSessionEnd(sessionId: string): void
  /** Fire `PermissionRequest` + `Notification` when a tool needs approval — the
   * "Claude needs your attention" moment (Claude Code parity). */
  onPermissionRequest(toolName: string, input: unknown): void
  /** Fire `PermissionDenied` when the user (or a hook) denies a tool. */
  onPermissionDenied(toolName: string, reason?: string): void
}

const defaultReadFile: FileReader = (absPath) => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/**
 * Build a {@link HookRunner}. The hook config is read once at construction; the
 * returned runner is cheap to call per event. A config with no groups for an
 * event short-circuits to a no-op (the common case), so the hot path costs one
 * map lookup when no hooks are configured.
 */
export function createHookRunner(deps: HookRunnerDeps): HookRunner {
  const spawn = deps.spawn ?? nodeSpawn
  const readFile = deps.readFile ?? defaultReadFile
  const claudeHome = path.join(deps.osHome ?? os.homedir(), ".claude")
  const builtinBaseDir = deps.builtinHooksDir ?? path.join(process.cwd(), "hooks", "builtin")
  const builtin = buildBuiltinHookGroups({
    baseDir: builtinBaseDir,
    overrides: deps.builtinHookOverrides,
  }) as HooksConfig
  const config: HooksConfig = loadHooks({ home: deps.home, claudeHome, readFile, builtin })

  const groupsFor = (event: HookEvent) => config[event] ?? []

  const fireLifecycle = (event: HookEvent, payload: Record<string, unknown>): void => {
    const groups = groupsFor(event)
    if (groups.length === 0) return
    // Observational: run the command handlers for their side effects; deny is
    // meaningless for lifecycle events, so the decision is intentionally ignored.
    void runHooks({ event, payload, groups, spawn }).catch(() => {})
  }

  return {
    onCapture(event) {
      const classified = classifyEvent(event)
      if (classified) fireLifecycle(classified.event, classified.fields)
    },
    onStop(ok) {
      fireLifecycle(ok ? "Stop" : "StopFailure", {})
    },
    onPrompt(prompt) {
      fireLifecycle("UserPromptSubmit", { prompt })
    },
    async preToolUse(toolName, input) {
      const groups = groupsFor("PreToolUse")
      if (groups.length === 0) return { deny: false }
      return runHooks({
        event: "PreToolUse",
        toolName,
        payload: { tool_name: toolName, tool_input: input },
        groups,
        spawn,
      })
    },
    onSessionStart(sessionId) {
      fireLifecycle("SessionStart", { session_id: sessionId })
    },
    onSessionEnd(sessionId) {
      fireLifecycle("SessionEnd", { session_id: sessionId })
    },
    onPermissionRequest(toolName, input) {
      fireLifecycle("PermissionRequest", { tool_name: toolName, tool_input: input })
      // A permission prompt is the canonical "needs your attention" event.
      fireLifecycle("Notification", {
        message: `Permission required for ${toolName}`,
        tool_name: toolName,
      })
    },
    onPermissionDenied(toolName, reason) {
      fireLifecycle("PermissionDenied", {
        tool_name: toolName,
        ...(reason ? { reason } : {}),
      })
    },
  }
}
