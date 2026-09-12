/** Plugin dispatch through the existing external manager, with durable Bot ownership. */
import type {
  ExternalAgentExecutionOptions,
  ExternalAgentResult,
} from "@/types/agent/external-agent"
import type { PluginWorkspaceHandle } from "../workspace/acquire"
import { assertOwnedBotWorkspace, digestBotArtifact } from "../workspace/bot-run"
import { getBotRunStep, completeBotRunStep } from "@/lib/db/bot-run-steps"
import { pluginHasApiPermission } from "./permission-api"
import { redactText } from "@cognia/redact"
import { assertNoLeakingPii } from "./plugin-pii-gate"
import { DEFAULT_EXTERNAL_AGENT_RETRY_CONFIG } from "@/types/agent/external-agent"
import { updateBotInstallation } from "@/lib/db/bot-installations"

export interface PluginExternalAgentOptions extends ExternalAgentExecutionOptions {
  runId?: string
  workspace?: PluginWorkspaceHandle
  timeoutMs?: number
  /** Stable step identity; use a new id for a deliberately subsequent turn. */
  invocationId?: string
}
export interface PluginExternalAgentResult extends ExternalAgentResult {
  agentId: string
  model?: string
  status: "completed" | "failed" | "cancelled" | "recovery_required"
  text: string
  usage?: ExternalAgentResult["tokenUsage"]
}

const SESSION_STEP = "__host:external-agent"
const activeBotRuns = new Set<string>()
interface AgentCheckpoint {
  pluginId: string
  agentId: string
  sessionId: string
  model: string
  promptHash: string
}

export async function runPluginExternalAgent(
  pluginId: string,
  presetOrAgentId: string,
  prompt: string,
  options: PluginExternalAgentOptions = {}
): Promise<PluginExternalAgentResult> {
  const key = options.runId ? `${pluginId}:${options.runId}` : undefined
  if (key && activeBotRuns.has(key)) throw new Error("A Bot external execution is already active")
  if (key) activeBotRuns.add(key)
  try {
    return await dispatchPluginExternalAgent(pluginId, presetOrAgentId, prompt, options)
  } finally {
    if (key) activeBotRuns.delete(key)
  }
}

async function dispatchPluginExternalAgent(
  pluginId: string,
  presetOrAgentId: string,
  prompt: string,
  options: PluginExternalAgentOptions
): Promise<PluginExternalAgentResult> {
  if (!pluginHasApiPermission(pluginId, "agent:dispatch-external"))
    throw new Error(
      'agent.runExternalAgent requires the "agent:dispatch-external" permission — declare it in the plugin manifest.'
    )
  if (!presetOrAgentId?.trim() || !prompt?.trim())
    throw new Error("External agent and non-empty prompt are required")
  prompt = redactText(prompt).redacted
  assertNoLeakingPii(pluginId, "ctx.agent.runExternalAgent", [prompt])
  const [{ getExternalAgentManager }, { createAgentFromPreset }] = await Promise.all([
    import("@/lib/ai/agent/external/manager"),
    import("@/lib/ai/agent/external/presets"),
  ])
  const manager = getExternalAgentManager()
  if (!options.runId) {
    if (options.workspace) throw new Error("A workspace requires a Bot run")
    let agentId = presetOrAgentId
    if (!manager.getAgent(agentId)) {
      const config = createAgentFromPreset(presetOrAgentId)
      if (!config)
        throw new Error(
          `agent.runExternalAgent: no live agent or preset "${presetOrAgentId}" found`
        )
      agentId = (await manager.addAgent(config)).config.id
    }
    const result = await manager.execute(agentId, prompt, options)
    return {
      ...result,
      agentId,
      model: options.model,
      text: result.finalResponse,
      status: result.success ? "completed" : options.signal?.aborted ? "cancelled" : "failed",
      usage: result.tokenUsage,
    }
  }
  const { runId, workspace } = options
  const invocationId = options.invocationId ?? "default"
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(invocationId)) throw new Error("Invalid external invocation id")
  const step = invocationId === "default" ? SESSION_STEP : `${SESSION_STEP}:${invocationId}`
  if (!workspace || workspace.runId !== runId)
    throw new Error("Bot agent execution requires its owned workspace")
  await assertOwnedBotWorkspace(pluginId, workspace)
  const needsSetup = async (message: string): Promise<never> => {
    const owned = await assertOwnedBotWorkspace(pluginId, workspace)
    await updateBotInstallation(owned.binding.installation.id, {
      status: "needs_setup",
      monitor: { ...owned.binding.installation.monitor, lastError: message },
    })
    throw new Error(message)
  }
  if (!workspace.runtimeStateRoot)
    throw new Error("Bot execution requires an isolated runtime state directory")
  if (!options.model) throw new Error("Bot agent execution requires an explicit model")
  const timeout = Math.min(options.timeoutMs ?? options.timeout ?? 30 * 60_000, 30 * 60_000)
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Execution timeout must be positive")
  if (
    presetOrAgentId === "devin" &&
    !["swe-2-medium", "swe-2-high", "swe-2-max"].includes(options.model)
  )
    return needsSetup("Unsupported Devin SWE-2 model")
  const { getLiveBotRunSignal } = await import("@/lib/bot/runtime/run")
  const hostSignal = getLiveBotRunSignal(runId)
  const signals = [hostSignal, options.signal].filter((signal): signal is AbortSignal =>
    Boolean(signal)
  )
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  if (signal?.aborted) throw new Error("Bot run was cancelled")
  const promptHash = await digestBotArtifact({
    prompt,
    model: options.model,
    workspace: workspace.id,
    presetOrAgentId,
  })
  const completed = await getBotRunStep(runId, `${step}:result`)
  const checkpoint = (await getBotRunStep(runId, step))?.output as AgentCheckpoint | undefined
  if (
    checkpoint &&
    (checkpoint.pluginId !== pluginId ||
      checkpoint.promptHash !== promptHash ||
      checkpoint.model !== options.model ||
      (options.sessionId && checkpoint.sessionId !== options.sessionId))
  )
    throw new Error("Run session identity cannot change during replay")
  if (completed?.status === "completed" && checkpoint)
    return completed.output as PluginExternalAgentResult
  const config = createAgentFromPreset(presetOrAgentId)
  if (!config) return needsSetup("Bot execution requires a registered external-agent preset")
  if (!config.process) return needsSetup("Bot execution requires an isolated process preset")
  const { agentInvoke } = await import("@/lib/ai/agent/external/agent-transport")
  if (!(await agentInvoke<boolean>("check_command_exists", { command: config.process.command })))
    return needsSetup(`External agent executable is unavailable: ${config.process.command}`)
  const priorSession = options.sessionId
    ? ((await getBotRunStep(runId, `${SESSION_STEP}:session:${options.sessionId}`))?.output as
        (AgentCheckpoint & { step: string }) | undefined)
    : undefined
  if (
    options.sessionId &&
    !checkpoint &&
    (!priorSession ||
      priorSession.pluginId !== pluginId ||
      priorSession.model !== options.model ||
      !(await getBotRunStep(runId, `${priorSession.step}:result`)))
  )
    throw new Error("A caller cannot attach an unowned or unfinished external session to a Bot run")
  const agentId = checkpoint?.agentId ?? priorSession?.agentId ?? `bot-${crypto.randomUUID()}`
  if (!manager.getAgent(agentId))
    await manager.addAgent({
      ...config,
      id: agentId,
      cogniaModel: undefined,
      retryConfig: { ...DEFAULT_EXTERNAL_AGENT_RETRY_CONFIG, maxRetries: 0 },
      process: config.process
        ? {
            ...config.process,
            cwd: workspace.root,
            env: {
              ...config.process.env,
              COGNIA_BOT_ISOLATION: "1",
              COGNIA_BOT_STATE_DIR: workspace.runtimeStateRoot!,
              DISABLE_AUTO_UPDATE: "1",
            },
          }
        : undefined,
      autoApprovePatterns: [],
    })
  const sessionOptions = {
    cwd: workspace.root,
    permissionMode: "default" as const,
    metadata: { selectedModel: options.model },
    mcpServers: [],
  }
  let sessionId = checkpoint?.sessionId ?? priorSession?.sessionId
  if (sessionId) {
    if (!manager.getSession(agentId, sessionId))
      await manager.resumeSession(agentId, sessionId, sessionOptions)
  } else {
    sessionId = (await manager.createSession(agentId, sessionOptions)).id
  }
  await completeBotRunStep(runId, step, {
    pluginId,
    agentId,
    sessionId,
    model: options.model,
    promptHash,
  } satisfies AgentCheckpoint)
  await completeBotRunStep(runId, `${SESSION_STEP}:session:${sessionId}`, {
    pluginId,
    agentId,
    sessionId,
    model: options.model,
    promptHash,
    step,
  })
  // Persisted before prompt dispatch. Never silently resubmit an uncertain turn after a process crash.
  const dispatched = await getBotRunStep(runId, `${step}:dispatched`)
  if (dispatched) {
    return {
      success: false,
      agentId,
      sessionId,
      model: options.model,
      status: "recovery_required",
      text: "",
      finalResponse: "",
      messages: [],
      steps: [],
      toolCalls: [],
      duration: 0,
      error:
        "A previous external turn has an uncertain outcome; inspect its recorded session before retrying.",
    }
  }
  const advertised = manager.getSessionModels(agentId, sessionId)
  if (
    advertised.status === "unsupported" ||
    (advertised.status === "ok" &&
      Array.isArray(advertised.data.availableModels) &&
      !advertised.data.availableModels.some((model) => model.modelId === options.model))
  )
    return needsSetup(`External agent does not offer the requested model: ${options.model}`)
  await manager.setSessionModel(agentId, sessionId, options.model)
  const models = manager.getSessionModels(agentId, sessionId)
  if (
    models.status === "unsupported" ||
    (models.status === "ok" && models.data.currentModelId !== options.model)
  )
    return needsSetup("External agent did not confirm the requested model")
  if (models.status === "error") throw models.error
  await assertOwnedBotWorkspace(pluginId, workspace)
  if (signal?.aborted) throw new Error("Bot run was cancelled")
  await completeBotRunStep(runId, `${step}:dispatched`, { sessionId, dispatchedAt: Date.now() })
  // Explicit fields prevent a plugin from replacing its owned cwd, trace, model route, or permission policy.
  const result = await manager.execute(agentId, prompt, {
    sessionId,
    model: options.model,
    cogniaModel: null,
    workingDirectory: workspace.root,
    timeout,
    signal,
    permissionMode: "default",
    onProgress: options.onProgress,
    onEvent: options.onEvent,
    traceContext: { sessionId: runId, tags: ["plugin-bot", pluginId] },
  })
  const response: PluginExternalAgentResult = {
    ...result,
    agentId,
    model: options.model,
    status: signal?.aborted ? "cancelled" : result.success ? "completed" : "failed",
    text: result.finalResponse,
    usage: result.tokenUsage,
  }
  await completeBotRunStep(runId, `${step}:result`, response)
  return response
}
