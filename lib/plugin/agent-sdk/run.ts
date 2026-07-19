/**
 * Plugin Agent SDK runtime — `runPluginAgent` (one-shot) and
 * `runPluginAgentStreamed` (async-iterable). Both adapt the typed
 * {@link PluginAgentRunOptions} onto the executor's `ExecuteAgentConfig`
 * (`lib/ai/agent/agent-executor.ts`), register the run with the
 * background-agent-manager for cancellation, and reuse the structured-output /
 * `canUseTool` / streaming plumbing the executor already threads.
 *
 * Permission gating (the `agent:control` check for tool-enabled runs) lives in
 * the caller (`lib/plugin/core/context.ts`); this module is permission-agnostic
 * so it stays unit-testable without the plugin manager.
 */

import {
  executeAgent,
  type ExecuteAgentConfig,
  type ExecuteAgentResult,
  type AgentTool,
} from "@/lib/ai/agent/agent-executor"
import { getBackgroundAgentManager } from "@/lib/ai/agent/background-agent-manager"
import { createPluginAgentRun } from "./stream"
import { runInputGuardrails, runOutputGuardrails } from "./guardrails"
import { resolveContextContributions } from "./context-providers"
import { withRunTrace } from "./tracing"
import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"
import type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
  PluginToolPermissionFn,
} from "@/types/plugin/plugin-agent-sdk"

export interface RunPluginAgentMeta {
  /** Owning plugin id (telemetry + bulk cancel). */
  pluginId?: string
  /** Human-readable label shown in the background-agent list. */
  label?: string
  /** Caller-chosen cancellation handle. Minted when omitted. */
  agentId?: string
}

/**
 * Compose the permission gates that guard a run into a single
 * {@link PluginToolPermissionFn}. Stages run in order and a `deny` from any one
 * short-circuits; each stage's (possibly rewritten) input flows into the next:
 *   1. per-tool `canUseTool` (declared on an inline tool)
 *   2. run-level `canUseTool`
 *   3. `hooks.onPreToolUse` lifecycle hook — sees the fully-rewritten input
 * Returns `undefined` when there is nothing to gate.
 */
function composeGate(
  runGate: PluginToolPermissionFn | undefined,
  tools: PluginAgentRunOptions["tools"],
  preToolUse: PluginToolPermissionFn | undefined
): PluginToolPermissionFn | undefined {
  const toolGates = new Map<string, PluginToolPermissionFn>()
  for (const tool of tools ?? []) {
    if (tool.canUseTool) toolGates.set(tool.name, tool.canUseTool)
  }
  if (!runGate && toolGates.size === 0 && !preToolUse) return undefined

  return async (toolName, input, ctx) => {
    let current = input
    for (const gate of [toolGates.get(toolName), runGate, preToolUse]) {
      if (!gate) continue
      const r = await gate(toolName, current, ctx)
      if (r.behavior === "deny") return r
      if (r.updatedInput) current = r.updatedInput
    }
    return current === input ? { behavior: "allow" } : { behavior: "allow", updatedInput: current }
  }
}

/** Map a plugin-facing inline tool onto the executor's `AgentTool`. */
function toAgentTool(tool: NonNullable<PluginAgentRunOptions["tools"]>[number]): AgentTool {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
    ...(tool.schema ? { schema: tool.schema } : {}),
    execute: (input) => Promise.resolve(tool.execute(input)),
    ...(tool.canUseTool ? { canUseTool: tool.canUseTool } : {}),
  }
}

/**
 * Translate `PluginAgentRunOptions` → `ExecuteAgentConfig`, binding the
 * cancellation signal and composed gate. `onEvent` is supplied by the streaming
 * caller; the one-shot caller leaves it undefined.
 */
function toExecuteConfig(
  options: PluginAgentRunOptions,
  signal: AbortSignal,
  onEvent?: ExecuteAgentConfig["onEvent"]
): ExecuteAgentConfig {
  const gate = composeGate(options.canUseTool, options.tools, options.hooks?.onPreToolUse)
  return {
    ...(options.system ? { systemPrompt: options.system } : {}),
    ...(options.appendSystem ? { appendSystem: options.appendSystem } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { defaultProvider: options.provider } : {}),
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools.map(toAgentTool) } : {}),
    ...(options.toolsEnabled !== undefined ? { toolsEnabled: options.toolsEnabled } : {}),
    ...(options.characterId ? { characterId: options.characterId } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.maxSteps !== undefined
      ? { maxSteps: options.maxSteps }
      : options.maxTurns !== undefined
        ? { maxSteps: options.maxTurns }
        : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    ...(gate ? { canUseTool: gate } : {}),
    ...(options.hooks?.onPostToolUse ? { onPostToolUse: options.hooks.onPostToolUse } : {}),
    abortSignal: signal,
    ...(onEvent ? { onEvent } : {}),
  }
}

/**
 * Fire the run's `onStop` hook (best-effort) with the final outcome. Called on
 * BOTH channels so a plugin always sees completion even when tools never ran.
 */
function fireStopHook(
  options: PluginAgentRunOptions,
  result: PluginAgentRunResult,
  signal: AbortSignal
): void {
  const onStop = options.hooks?.onStop
  if (!onStop) return
  try {
    void Promise.resolve(
      onStop(
        {
          text: result.text,
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          channel: result.channel,
        },
        { signal }
      )
    ).catch(() => undefined)
  } catch {
    /* onStop is best-effort */
  }
}

function newAgentId(meta?: RunPluginAgentMeta): string {
  return meta?.agentId && meta.agentId.length > 0 ? meta.agentId : crypto.randomUUID()
}

/**
 * Append every registered context provider's contribution to `appendSystem`
 * (Package E). Returns the options unchanged when nothing is contributed.
 */
async function withContextContributions(
  prompt: string,
  options: PluginAgentRunOptions
): Promise<PluginAgentRunOptions> {
  const contribution = await resolveContextContributions({ prompt })
  if (!contribution) return options
  const appendSystem = [options.appendSystem, contribution].filter(Boolean).join("\n\n")
  if (!hasNoLeakingPii(appendSystem)) {
    throw new Error("Plugin context contribution failed the outbound PII gate")
  }
  return { ...options, appendSystem }
}

/**
 * Execute a run with the Package F robustness wrappers: a per-run trace span
 * and an optional one-shot fallback-model retry. Fallback is disabled for the
 * streamed path (a retry would re-emit already-pushed events).
 */
function executeWithRobustness(
  prompt: string,
  opts: PluginAgentRunOptions,
  signal: AbortSignal,
  meta: { agentId: string; pluginId?: string },
  onEvent: ExecuteAgentConfig["onEvent"] | undefined,
  enableFallback: boolean
): Promise<ExecuteAgentResult> {
  if (
    !hasNoLeakingPiiDeep({
      prompt,
      system: opts.system,
      appendSystem: opts.appendSystem,
    })
  ) {
    throw new Error("Plugin agent input failed the outbound PII gate")
  }
  const runOnce = (model?: string): Promise<ExecuteAgentResult> => {
    const cfg = toExecuteConfig(model ? { ...opts, model } : opts, signal, onEvent)
    const traceModel = model ?? opts.model
    return withRunTrace(
      Boolean(opts.trace),
      {
        agentId: meta.agentId,
        ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
        ...(traceModel ? { model: traceModel } : {}),
      },
      prompt,
      () => executeAgent(prompt, cfg)
    )
  }
  if (!enableFallback || !opts.fallbackModel) return runOnce()
  const fallbackModel = opts.fallbackModel
  return runOnce().catch(() => runOnce(fallbackModel))
}

/** Run a single agent turn and resolve with the typed result. */
export async function runPluginAgent(
  prompt: string,
  options: PluginAgentRunOptions = {},
  meta: RunPluginAgentMeta = {}
): Promise<PluginAgentRunResult> {
  const manager = getBackgroundAgentManager()
  const agentId = newAgentId(meta)
  const managedSignal = manager.registerAgent(agentId, {
    kind: "plugin-agent",
    prompt,
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  })
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, managedSignal])
    : managedSignal

  try {
    await runInputGuardrails(prompt, options.guardrails, signal)
    const opts = await withContextContributions(prompt, options)
    const result = await executeWithRobustness(
      prompt,
      opts,
      signal,
      { agentId, ...(meta.pluginId ? { pluginId: meta.pluginId } : {}) },
      undefined,
      true
    )
    const withId = { ...result, agentId }
    await runOutputGuardrails(prompt, result.text, options.guardrails, signal)
    fireStopHook(options, withId, signal)
    // Settle with the real outcome so the journal row carries text/usage.
    manager.finishAgent(agentId, {
      text: result.text,
      ...(result.usage ? { usage: result.usage } : {}),
    })
    return withId
  } catch (err) {
    manager.finishAgent(agentId, { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    // Settle-once backstop for any path that slipped past the two above.
    manager.finishAgent(agentId)
  }
}

/**
 * Run an agent turn as a live async-iterable. Emits `text-delta` / `tool-call`
 * events, resolves `.result`, and `.cancel()` aborts the underlying run.
 */
export function runPluginAgentStreamed(
  prompt: string,
  options: PluginAgentRunOptions = {},
  meta: RunPluginAgentMeta = {}
): PluginAgentRun {
  const manager = getBackgroundAgentManager()
  const agentId = newAgentId(meta)
  const managedSignal = manager.registerAgent(agentId, {
    kind: "plugin-agent",
    prompt,
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  })
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, managedSignal])
    : managedSignal

  const controller = createPluginAgentRun(agentId, () => manager.cancelAgent(agentId))

  void (async () => {
    try {
      await runInputGuardrails(prompt, options.guardrails, signal)
      const opts = await withContextContributions(prompt, options)
      const result = await executeWithRobustness(
        prompt,
        opts,
        signal,
        { agentId, ...(meta.pluginId ? { pluginId: meta.pluginId } : {}) },
        (event) => {
          // The plugin agent stream surfaces only text/tool events — capture-only
          // events (thinking-delta, usage, compact) have no PluginAgentStreamEvent
          // counterpart, so they're dropped here.
          if (
            event.type === "text-delta" ||
            event.type === "tool-call" ||
            event.type === "tool-result"
          ) {
            controller.push(event)
          }
        },
        false
      )
      const withId = { ...result, agentId }
      await runOutputGuardrails(prompt, result.text, options.guardrails, signal)
      fireStopHook(options, withId, signal)
      manager.finishAgent(agentId, {
        text: result.text,
        ...(result.usage ? { usage: result.usage } : {}),
      })
      controller.close(withId)
    } catch (err) {
      manager.finishAgent(agentId, { error: err instanceof Error ? err.message : String(err) })
      controller.fail(err)
    } finally {
      manager.finishAgent(agentId)
    }
  })()

  return controller.run
}
