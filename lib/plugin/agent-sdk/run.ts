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
  type AgentTool,
} from "@/lib/ai/agent/agent-executor"
import { getBackgroundAgentManager } from "@/lib/ai/agent/background-agent-manager"
import { createPluginAgentRun } from "./stream"
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
 * Compose a run-level gate with any per-tool gates declared on inline tools.
 * The tool-level gate runs first; its (possibly rewritten) input flows into the
 * run-level gate. A `deny` from either short-circuits. Returns `undefined` when
 * there is nothing to gate.
 */
function composeGate(
  runGate: PluginToolPermissionFn | undefined,
  tools: PluginAgentRunOptions["tools"]
): PluginToolPermissionFn | undefined {
  const toolGates = new Map<string, PluginToolPermissionFn>()
  for (const tool of tools ?? []) {
    if (tool.canUseTool) toolGates.set(tool.name, tool.canUseTool)
  }
  if (!runGate && toolGates.size === 0) return undefined

  return async (toolName, input, ctx) => {
    let current = input
    const toolGate = toolGates.get(toolName)
    if (toolGate) {
      const r = await toolGate(toolName, current, ctx)
      if (r.behavior === "deny") return r
      if (r.updatedInput) current = r.updatedInput
    }
    if (runGate) {
      const r = await runGate(toolName, current, ctx)
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
  const gate = composeGate(options.canUseTool, options.tools)
  return {
    ...(options.system ? { systemPrompt: options.system } : {}),
    ...(options.appendSystem ? { appendSystem: options.appendSystem } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { defaultProvider: options.provider } : {}),
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools.map(toAgentTool) } : {}),
    ...(options.toolsEnabled !== undefined ? { toolsEnabled: options.toolsEnabled } : {}),
    ...(options.characterId ? { characterId: options.characterId } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    ...(gate ? { canUseTool: gate } : {}),
    abortSignal: signal,
    ...(onEvent ? { onEvent } : {}),
  }
}

function newAgentId(meta?: RunPluginAgentMeta): string {
  return meta?.agentId && meta.agentId.length > 0 ? meta.agentId : crypto.randomUUID()
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
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  })
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, managedSignal])
    : managedSignal

  try {
    const result = await executeAgent(prompt, toExecuteConfig(options, signal))
    return { ...result, agentId }
  } finally {
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
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.label ? { label: meta.label } : {}),
  })
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, managedSignal])
    : managedSignal

  const controller = createPluginAgentRun(agentId, () => manager.cancelAgent(agentId))

  void (async () => {
    try {
      const result = await executeAgent(
        prompt,
        toExecuteConfig(options, signal, (event) => controller.push(event))
      )
      controller.close({ ...result, agentId })
    } catch (err) {
      controller.fail(err)
    } finally {
      manager.finishAgent(agentId)
    }
  })()

  return controller.run
}
