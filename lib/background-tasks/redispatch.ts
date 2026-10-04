/**
 * Re-dispatch an interrupted (or finished) background run from its journal
 * row — the crash-recovery path. Two entry points share it:
 *
 *  - Job Center "Re-run" (kind `manual`): explicit user intent, resets the
 *    auto-resume attempt counter.
 *  - Lease-expiry auto-resume (kind `auto`, opt-in via
 *    `settings.backgroundTasks.autoResumeInterrupted`): re-dispatches expired
 *    owners and unclaimed versioned recovery records, chaining
 *    the attempt counter so a crash loop caps out instead of burning tokens.
 *
 * Never throws — failures resolve to a structured outcome the caller can
 * surface (toast / notification).
 */

import type { BackgroundTaskJournalRecord, BackgroundDispatchRecovery } from "./registry-core"
import type { ResolvedCaller } from "@/lib/claude/agents/dispatch-run"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { computeStableDigest } from "@/lib/ai/agent/execution/fingerprint"
import { getDb } from "@/lib/db/schema"
import { BACKGROUND_TASK_LEASE_TTL_MS } from "@/lib/db/background-tasks"

export type RedispatchOutcome =
  | { ok: true; runId: string }
  | {
      ok: false
      reason:
        | "missing-subagent"
        | "still-running"
        | "attempt-cap"
        | "recovery-required"
        | "dispatch-failed"
      message: string
    }

export interface RedispatchOptions {
  kind: "manual" | "auto"
  /** Attempt cap for `auto` chains (default 2). Ignored for `manual`. */
  maxAutoResumeAttempts?: number
  /** A stopped maintenance owner must not dispatch after an asynchronous lookup. */
  isCurrent?: () => boolean
}

export const DEFAULT_MAX_AUTO_RESUME_ATTEMPTS = 2

/** Freeze only dispatch-owned inputs; no secrets or new tool policy registry. */
export async function captureBackgroundDispatchRecovery(input: {
  sessionId: string
  executionSessionId: string
  caller: ResolvedCaller
  target: PluginSubagentDef
  toolsEnabled: boolean
}): Promise<BackgroundDispatchRecovery> {
  const [{ getDb }, { getSettings }, { getSession }, { getDeviceId }] = await Promise.all([
    import("@/lib/db/schema"),
    import("@/lib/db/settings"),
    import("@/lib/db/sessions"),
    import("@/lib/device/device-identity"),
  ])
  const db = getDb()
  const [settings, parent, hostId] = await Promise.all([
    getSettings(),
    getSession(input.sessionId),
    getDeviceId(),
  ])
  if (getDb() !== db || !parent || !settings || !hostId) {
    throw new Error("Background execution context is unavailable or changed")
  }
  const { isTauri } = await import("@/lib/tauri")
  const { resolveAgentExecutionEnvironment } =
    await import("@/lib/ai/agent/execution/host-environment")
  const environment = resolveAgentExecutionEnvironment()
  // These hooks may run arbitrary commands even when model tools are disabled.
  // A missing native configuration read is uncertainty, never no-effect proof.
  let nativeLifecycleHooks: unknown =
    environment.pairedHost || environment.isHeadlessHost ? "uninspected-host" : null
  if (isTauri()) {
    try {
      const { readClaudeEffectiveSettings } = await import("@/lib/claude/settings")
      const native = await readClaudeEffectiveSettings(input.caller.cwd)
      nativeLifecycleHooks = [native.user, native.project, native.local]
        .flatMap((layer) => Object.values(layer?.hooks ?? {}))
        .filter((groups) => (Array.isArray(groups) ? groups.length > 0 : Boolean(groups)))
    } catch {
      nativeLifecycleHooks = "unreadable"
    }
  }
  if (getDb() !== db) throw new Error("Background execution context changed")
  const { listEnabledHookPlugins } = await import("@/lib/plugin/registries/hook-registry")
  const enabledHookPlugins = listEnabledHookPlugins()
  const hasNativeLifecycleEffects =
    nativeLifecycleHooks !== null &&
    (!Array.isArray(nativeLifecycleHooks) || nativeLifecycleHooks.length > 0)
  const { deadlineMs: _deadlineMs, ...callerIdentity } = input.caller
  // Finite subtree consumption lives in memory; its loss cannot reset a budget.
  const noEffects =
    !input.target.externalPresetId &&
    !hasNativeLifecycleEffects &&
    enabledHookPlugins.length === 0 &&
    (!input.toolsEnabled || input.target.tools?.length === 0)
  return {
    version: 1,
    phase: "accepted",
    namespaceId: db.name,
    hostId,
    executionSessionId: input.executionSessionId,
    caller: structuredClone(input.caller),
    target: structuredClone(input.target),
    sideEffect: noEffects ? "none" : "non-idempotent",
    contextFingerprint: computeStableDigest("background-dispatch-v1", {
      namespaceId: db.name,
      hostId,
      target: input.target,
      caller: callerIdentity,
      toolsEnabled: input.toolsEnabled,
      parent: {
        id: parent.id,
        projectId: parent.projectId,
        executionContext: parent.executionContext,
        permissionMode: parent.permissionMode,
        providerOverride: parent.providerOverride,
        accountId: parent.accountId,
        workingDir: parent.workingDir,
      },
      // A settings change may affect provider/account selection or tool policy.
      // Compare the digest; never persist the settings/credential payload here.
      settings,
      nativeLifecycleHooks,
      environment,
      enabledHookPlugins,
    }),
  }
}

/**
 * Re-dispatch a journaled run with its original subagent/prompt/tool flag as
 * a new BACKGROUND run, linking provenance both ways.
 */
export async function redispatchBackgroundRun(
  record: BackgroundTaskJournalRecord,
  options: RedispatchOptions
): Promise<RedispatchOutcome> {
  if (record.status === "running") {
    return {
      ok: false,
      reason: "still-running",
      message: `Run "${record.runId}" is still running.`,
    }
  }
  const priorAttempt = record.resumeAttempt ?? 0
  const cap = options.maxAutoResumeAttempts ?? DEFAULT_MAX_AUTO_RESUME_ATTEMPTS
  if (options.kind === "auto" && priorAttempt >= cap) {
    return {
      ok: false,
      reason: "attempt-cap",
      message: `Run "${record.runId}" reached the auto-resume cap (${cap}).`,
    }
  }

  const [{ getDispatchableSubagentDef }, { resolveCaller, startDispatchRun }] = await Promise.all([
    import("@/lib/claude/agents/subagents"),
    import("@/lib/claude/agents/dispatch-run"),
  ])
  if (!getDispatchableSubagentDef(record.subagentId)) {
    return {
      ok: false,
      reason: "missing-subagent",
      message: `Subagent "${record.subagentId}" is no longer available.`,
    }
  }

  try {
    const assertCurrent = () => {
      if (options.isCurrent && !options.isCurrent()) {
        throw new Error("Background recovery scope stopped or changed")
      }
    }
    assertCurrent()
    if (record.recovery) {
      const { getDb } = await import("@/lib/db/schema")
      if (getDb().name !== record.recovery.namespaceId) {
        return {
          ok: false,
          reason: "recovery-required",
          message: "Background work belongs to a different account or runtime target.",
        }
      }
    }
    let caller = await resolveCaller(record.sessionId)
    let recovery: BackgroundDispatchRecovery | undefined
    if (options.kind === "auto") {
      const saved = record.recovery
      const { getSettings } = await import("@/lib/db/settings")
      const settings = await getSettings()
      if (
        !saved ||
        saved.version !== 1 ||
        (saved.phase !== "accepted" && saved.phase !== "dispatched") ||
        record.status !== "interrupted" ||
        record.kind !== "subagent" ||
        record.host !== "renderer" ||
        record.mode !== "background" ||
        record.resumedByRunId ||
        record.cancelRequestedAt !== undefined ||
        saved.target.externalPresetId ||
        (saved.phase === "dispatched" &&
          (saved.sideEffect !== "none" ||
            (record.toolsEnabled !== false && saved.target.tools?.length !== 0))) ||
        saved.caller.parentDepth !== 0 ||
        (settings?.subagentNesting?.tokenBudget ?? 0) > 0 ||
        (saved.caller.deadlineMs !== undefined && saved.caller.deadlineMs <= Date.now())
      ) {
        return {
          ok: false,
          reason: "recovery-required",
          message: "Interrupted work needs an explicit restart: safe replay is not proven.",
        }
      }
      const current = await captureBackgroundDispatchRecovery({
        sessionId: record.sessionId,
        executionSessionId: saved.executionSessionId,
        caller,
        target: {
          ...getDispatchableSubagentDef(record.subagentId)!,
          ...(record.model ? { model: record.model } : {}),
        },
        toolsEnabled: record.toolsEnabled ?? true,
      })
      if (
        current.contextFingerprint !== saved.contextFingerprint ||
        (saved.phase === "dispatched" && current.sideEffect !== "none")
      ) {
        return {
          ok: false,
          reason: "recovery-required",
          message: "The original background execution context changed.",
        }
      }
      caller = saved.caller
      recovery = saved
    }
    assertCurrent()
    const handle = await startDispatchRun({
      subagentId: record.subagentId,
      prompt: record.prompt,
      toolsEnabled: record.toolsEnabled ?? true,
      ...(record.model ? { model: record.model } : {}),
      background: true,
      parentSessionId: record.sessionId,
      caller,
      resumeOfRunId: record.runId,
      ...(recovery ? { recovery } : {}),
      // Manual re-run = explicit user intent, reset the chain; auto chains it.
      resumeAttempt: options.kind === "auto" ? priorAttempt + 1 : 0,
    })

    if (handle.error) return { ok: false, reason: "dispatch-failed", message: handle.error }
    const { runId } = handle
    try {
      const { updateBackgroundTaskRecord } = await import("@/lib/db/background-tasks")
      assertCurrent()
      await updateBackgroundTaskRecord(record.runId, { resumedByRunId: runId })
    } catch {
      // Provenance bookkeeping is best-effort.
    }
    return { ok: true, runId }
  } catch (error) {
    return {
      ok: false,
      reason: options.kind === "auto" ? "recovery-required" : "dispatch-failed",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Recheck expiring owners without adding a second task scheduler. */
export function startBackgroundTaskRecovery(
  options: {
    onResumed?: (count: number) => void | Promise<void>
  } = {}
): () => void {
  const database = getDb()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const isCurrent = () => {
    if (stopped) return false
    try {
      return getDb() === database
    } catch {
      return false
    }
  }
  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
  const tick = async (boot: boolean) => {
    try {
      if (!isCurrent()) return
      const [
        { interruptRendererBackgroundTasksOnBoot },
        { pruneBackgroundTaskRecords },
        { getSettings },
      ] = await Promise.all([
        import("./renderer-subagent-registry"),
        import("@/lib/db/background-tasks"),
        import("@/lib/db/settings"),
      ])
      if (!isCurrent()) return
      if (boot) {
        const { recoverStaleDirectChatExecutionRuns } =
          await import("@/lib/execution/direct-chat-run")
        if (!isCurrent()) return
        await recoverStaleDirectChatExecutionRuns().catch(() => undefined)
        if (!isCurrent()) return
      }
      const interrupted = await interruptRendererBackgroundTasksOnBoot()
      if (!isCurrent()) return
      if (boot) {
        await pruneBackgroundTaskRecords({ now: Date.now(), host: "renderer" }).catch(
          () => undefined
        )
        if (!isCurrent()) return
      }
      if (interrupted.length === 0) return
      const settings = await getSettings()
      if (!isCurrent() || !settings?.backgroundTasks?.autoResumeInterrupted) return
      const cap = settings.backgroundTasks.maxAutoResumeAttempts ?? DEFAULT_MAX_AUTO_RESUME_ATTEMPTS
      let resumed = 0
      for (const record of interrupted) {
        if (!isCurrent()) return
        if (record.kind !== "subagent" || record.mode !== "background") continue
        const outcome = await redispatchBackgroundRun(record, {
          kind: "auto",
          maxAutoResumeAttempts: cap,
          isCurrent,
        })
        if (outcome.ok) resumed += 1
      }
      if (isCurrent() && resumed > 0) await options.onResumed?.(resumed)
    } catch {
      // A failed check is retried on the next tick; boot and shutdown stay available.
    } finally {
      if (isCurrent()) {
        timer = setTimeout(() => void tick(false), Math.floor(BACKGROUND_TASK_LEASE_TTL_MS / 3))
        ;(timer as { unref?: () => void }).unref?.()
      }
    }
  }
  void tick(true)
  return stop
}
