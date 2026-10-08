/** Runtime-neutral session operations implemented with OMP's typed protocol. */
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import type {
  AcpAvailableCommand,
  AcpSessionModelState,
  ExternalAgentContent,
  ExternalAgentMessage,
} from "@cognia/agent-contracts/external-agent"
import { catalogModelCapabilities } from "@cognia/agent-contracts/external-agent"
import type {
  ExternalAgentCompactionCapability,
  ExternalAgentCompactionOptions,
  ExternalAgentSessionEntry,
  ExternalAgentSessionInput,
  ExternalAgentSessionInputAcceptance,
  ExternalAgentSessionInputMode,
  ExternalAgentSessionInputQueue,
  ExternalAgentSessionQueuePolicy,
  ExternalAgentSessionRuntimeControls,
  ExternalAgentSessionRuntimeState,
  ExternalAgentSessionShellAbortResult,
  ExternalAgentSessionShellOptions,
  ExternalAgentSessionShellResult,
  ExternalAgentSessionTree,
  ExternalAgentSessionTreeNode,
} from "@cognia/agent-contracts/session-operations"
import { OmpSessionClient } from "./session-client"
import { ompStatsToTokenUsage } from "./rpc-events"
import type { SessionState } from "./wire"

const emptyQueue = (): ExternalAgentSessionInputQueue => ({ steering: [], followUp: [] })
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

export interface OmpClearedInputQueue extends ExternalAgentSessionInputQueue {
  /** OMP exposes queue text, not attachment identities. These are candidates,
   * not proven attachments of the removed messages; the host must reconcile. */
  unverifiedAttachments?: ExternalAgentSessionInputQueue
}

/** Some messages may already be delivered and no longer removable. Never restore those. */
export class OmpQueueClearError extends Error {
  readonly unverifiedAttachments?: ExternalAgentSessionInputQueue
  constructor(
    readonly removed: OmpClearedInputQueue,
    readonly remaining: ExternalAgentSessionInputQueue | undefined,
    options?: ErrorOptions,
    readonly reason:
      "removal-incomplete" | "attachment-provenance-unavailable" = "removal-incomplete"
  ) {
    super(
      reason === "attachment-provenance-unavailable"
        ? "OMP queue removed; attachment association requires host reconciliation"
        : "OMP input queue was not completely cleared",
      options
    )
    this.name = "OmpQueueClearError"
    this.unverifiedAttachments = removed.unverifiedAttachments
  }
}
export abstract class OmpOperationAdapter extends BaseProtocolAdapter {
  abstract getOmpSession(sessionId: string): OmpSessionClient
  private queuedInputs = new Map<string, ExternalAgentSessionInputQueue>()
  private controls = new Map<string, ExternalAgentSessionRuntimeControls>()
  private clearing = new Set<string>()
  private shells = new Map<string, { cancelled: boolean }>()
  private permissionSequence = 0

  /** Called by the process-owning adapter after a successful transition or teardown. */
  protected resetOmpOperations(sessionId: string): void {
    this.queuedInputs.delete(sessionId)
    this.controls.delete(sessionId)
    this.clearing.delete(sessionId)
    const shell = this.shells.get(sessionId)
    if (shell) shell.cancelled = true
    this.shells.delete(sessionId)
  }
  async getSessionModels(sessionId: string): Promise<AcpSessionModelState> {
    const client = this.getOmpSession(sessionId)
    const [state, catalog] = await Promise.all([client.getState(), client.getAvailableModels()])
    return {
      currentModelId: state.model ? `${state.model.provider}/${state.model.id}` : "",
      availableModels: catalog.models.map((model) => {
        const capabilities = catalogModelCapabilities(model)
        return {
          modelId: `${model.provider}/${model.id}`,
          name: model.name || model.id,
          ...(capabilities ? { capabilities } : {}),
        }
      }),
    }
  }
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const split = modelId.indexOf("/")
    if (split < 1 || split === modelId.length - 1)
      throw new Error("OMP model must use provider/modelId")
    await this.getOmpSession(sessionId).setModel({
      provider: modelId.slice(0, split),
      modelId: modelId.slice(split + 1),
    })
  }
  async steerTurn(sessionId: string, text: string): Promise<void> {
    await this.enqueueSessionInput(sessionId, { text }, "steer")
  }
  async enqueueSessionInput(
    sessionId: string,
    input: ExternalAgentSessionInput,
    mode: ExternalAgentSessionInputMode
  ): Promise<ExternalAgentSessionInputAcceptance> {
    if (mode !== "steer" && mode !== "follow_up") throw new Error("Invalid OMP input mode")
    if (typeof input.text !== "string" || (!input.text.trim() && !input.images?.length))
      throw new Error("OMP input must contain text or images")
    if (this.clearing.has(sessionId)) throw new Error("OMP queue clear is in progress")
    for (const image of input.images ?? [])
      if (!image.data || !image.mimeType)
        throw new Error("OMP images require inline data and MIME type")
    const client = this.getOmpSession(sessionId)
    const queue = this.queuedInputs.get(sessionId) ?? emptyQueue()
    this.queuedInputs.set(sessionId, queue)
    // Keep images through ambiguous transport failures: an acknowledged deletion
    // is the only safe point at which to return them for restoration.
    queue[mode === "steer" ? "steering" : "followUp"].push(structuredClone(input))
    const params = {
      message: input.text,
      ...(input.images?.length
        ? { images: input.images.map((image) => ({ type: "image" as const, ...image })) }
        : {}),
    }
    if (mode === "steer") await client.steer(params)
    else await client.followUp(params)
    return { mode, disposition: "queued" }
  }
  async clearSessionInputQueue(sessionId: string): Promise<OmpClearedInputQueue> {
    if (this.clearing.has(sessionId)) throw new Error("OMP queue clear is already in progress")
    const client = this.getOmpSession(sessionId)
    this.clearing.add(sessionId)
    const removed: OmpClearedInputQueue = emptyQueue()
    const cache = this.queuedInputs.get(sessionId)
    if (cache) {
      const candidates = {
        steering: cache.steering.filter((input) => input.images?.length),
        followUp: cache.followUp.filter((input) => input.images?.length),
      }
      if (candidates.steering.length || candidates.followUp.length)
        removed.unverifiedAttachments = structuredClone(candidates)
    }
    try {
      const snapshot = queueFromState(await client.getState())
      // Raw clients and autonomous extensions can replace equal-text queue
      // entries. Never attach cached images to a wire identity OMP cannot prove.
      for (const [key, queue] of [
        ["steering", "steering"],
        ["followUp", "followUp"],
      ] as const) {
        for (const input of snapshot[key]) {
          const result = await client.removeQueuedMessage({ message: input.text, queue })
          if (!result.removed) throw new Error("OMP queued message is no longer removable")
          removed[key].push(input)
        }
      }
      const remaining = queueFromState(await client.getState())
      if (remaining.steering.length || remaining.followUp.length)
        throw new OmpQueueClearError(removed, remaining)
      this.queuedInputs.delete(sessionId)
      if (removed.unverifiedAttachments)
        throw new OmpQueueClearError(
          removed,
          remaining,
          undefined,
          "attachment-provenance-unavailable"
        )
      return removed
    } catch (error) {
      if (error instanceof OmpQueueClearError) throw error
      let remaining: ExternalAgentSessionInputQueue | undefined
      try {
        remaining = queueFromState(await client.getState())
      } catch {
        /* Unknown is not an empty queue. */
      }
      throw new OmpQueueClearError(removed, remaining, { cause: error })
    } finally {
      this.clearing.delete(sessionId)
    }
  }
  async refreshSessionCommands(sessionId: string): Promise<AcpAvailableCommand[]> {
    const result = await this.getOmpSession(sessionId).getAvailableCommands()
    return result.commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      ...(command.input ? { input: { hint: command.input.hint ?? "" } } : {}),
    }))
  }
  async setSessionQueuePolicy(
    sessionId: string,
    policy: ExternalAgentSessionQueuePolicy
  ): Promise<void> {
    for (const mode of [policy.steering, policy.followUp])
      if (mode !== undefined && mode !== "all" && mode !== "one-at-a-time")
        throw new Error("Invalid OMP queue policy")
    const client = this.getOmpSession(sessionId)
    if (policy.steering !== undefined) await client.setSteeringMode({ mode: policy.steering })
    if (policy.followUp !== undefined) await client.setFollowUpMode({ mode: policy.followUp })
  }
  async setSessionRuntimeControls(
    sessionId: string,
    controls: ExternalAgentSessionRuntimeControls
  ): Promise<void> {
    for (const value of [controls.autoCompaction, controls.autoRetry])
      if (value !== undefined && typeof value !== "boolean")
        throw new Error("OMP runtime controls require booleans")
    const client = this.getOmpSession(sessionId)
    const saved = this.controls.get(sessionId) ?? {}
    this.controls.set(sessionId, saved)
    if (controls.autoCompaction !== undefined) {
      await client.setAutoCompaction({ enabled: controls.autoCompaction })
      saved.autoCompaction = controls.autoCompaction
    }
    if (controls.autoRetry !== undefined) {
      await client.setAutoRetry({ enabled: controls.autoRetry })
      saved.autoRetry = controls.autoRetry
    }
  }
  async getSessionRuntimeState(sessionId: string): Promise<ExternalAgentSessionRuntimeState> {
    const state = await this.getOmpSession(sessionId).getState()
    return {
      queuePolicy: { steering: state.steeringMode, followUp: state.followUpMode },
      controls: { ...this.controls.get(sessionId), autoCompaction: state.autoCompactionEnabled },
      pendingInputCount: state.queuedMessageCount,
    }
  }
  async abortSessionRetry(sessionId: string): Promise<void> {
    await this.getOmpSession(sessionId).abortRetry()
  }
  async getSessionEntries(sessionId: string, since?: string): Promise<ExternalAgentSessionEntry[]> {
    const result = await this.getOmpSession(sessionId).getEntries(
      since === undefined ? {} : { since }
    )
    return result.entries.map(normalizeOmpSessionEntry)
  }
  async getSessionTree(sessionId: string): Promise<ExternalAgentSessionTree> {
    const result = await this.getOmpSession(sessionId).getTree()
    const roots: ExternalAgentSessionTreeNode[] = []
    const pending = result.tree.map((node) => ({ node, target: roots }))
    const seen = new Set<string>()
    while (pending.length) {
      const current = pending.pop()!
      const entry = normalizeOmpSessionEntry(record(current.node.entry) ?? {})
      if (seen.has(entry.id))
        throw new Error("OMP session tree contains a duplicate or cyclic entry")
      seen.add(entry.id)
      const mapped: ExternalAgentSessionTreeNode = { entry, children: [] }
      current.target.unshift(mapped)
      if (!Array.isArray(current.node.children))
        throw new Error("Invalid OMP session tree children")
      for (const child of current.node.children) {
        const node = record(child)
        if (!node) throw new Error("Invalid OMP session tree node")
        pending.push({ node, target: mapped.children })
      }
    }
    return { roots, leafId: result.leafId }
  }
  async renameSession(sessionId: string, name: string): Promise<void> {
    if (!name.trim()) throw new Error("OMP session name cannot be empty")
    await this.getOmpSession(sessionId).setSessionName({ name })
    this.updateSession(sessionId, {
      metadata: { ...this.getSession(sessionId)?.metadata, title: name },
    })
  }
  async exportSessionHtml(sessionId: string): Promise<{ path: string }> {
    return this.getOmpSession(sessionId).exportHtml()
  }
  async getCompactionCapability(sessionId: string): Promise<ExternalAgentCompactionCapability> {
    this.getOmpSession(sessionId)
    return { status: "supported", routes: [{ kind: "native", supportsFocus: true }] }
  }
  async compactSession(sessionId: string, options?: ExternalAgentCompactionOptions): Promise<void> {
    await this.getOmpSession(sessionId).compact(
      options?.focus ? { customInstructions: options.focus } : {}
    )
  }
  async executeSessionShell(
    sessionId: string,
    command: string,
    options: ExternalAgentSessionShellOptions
  ): Promise<ExternalAgentSessionShellResult> {
    if (!command.trim()) throw new Error("OMP shell command cannot be empty")
    if (typeof options?.onPermissionRequest !== "function")
      throw new Error("OMP shell requires a permission callback")
    if (options.excludeFromContext)
      throw new Error("OMP bash RPC does not support excludeFromContext")
    if (this.shells.has(sessionId)) throw new Error("OMP shell is already running")
    const client = this.getOmpSession(sessionId)
    const shell = { cancelled: false }
    this.shells.set(sessionId, shell)
    try {
      if ((await client.getState()).isSettled !== true)
        throw new Error("OMP shell requires a settled session")
      if (shell.cancelled) throw new Error("OMP shell was cancelled before approval")
      const id = `${sessionId}:omp-shell:${++this.permissionSequence}`
      const permission = await options.onPermissionRequest({
        id,
        requestId: id,
        sessionId,
        title: "Run shell command",
        toolInfo: { id: "bash", name: "bash" },
        rawInput: { command },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      })
      if (shell.cancelled) throw new Error("OMP shell was cancelled during approval")
      if (permission?.granted !== true || permission.requestId !== id)
        throw new Error("OMP shell permission denied")
      if ((await client.getState()).isSettled !== true)
        throw new Error("OMP session became busy during shell approval")
      if (shell.cancelled) throw new Error("OMP shell was cancelled during approval")
      // The trusted native extension independently authorizes and executes this
      // request; the shared permission response never grants a bypass token.
      const result = await client.bash({ command })
      return {
        output: result.output,
        exitCode: result.exitCode ?? null,
        cancelled: result.cancelled,
        truncated: result.truncated,
      }
    } finally {
      if (this.shells.get(sessionId) === shell) this.shells.delete(sessionId)
    }
  }
  async abortSessionShell(sessionId: string): Promise<ExternalAgentSessionShellAbortResult> {
    const shell = this.shells.get(sessionId)
    if (shell) shell.cancelled = true
    // OMP allocates its native bash AbortController only after user_bash
    // handlers return. A guarded host executor runs inside that hook, so
    // abort_bash cannot interrupt it. Retire the process for a real stop.
    await this.closeSession(sessionId)
    return { resumeRequired: true }
  }
}
function queueFromState(state: SessionState): ExternalAgentSessionInputQueue {
  const queue = state.queuedMessages
  if (!queue || !Array.isArray(queue.steering) || !Array.isArray(queue.followUp))
    throw new Error("OMP did not return an authoritative input queue")
  return {
    steering: queue.steering.map((text) => ({ text })),
    followUp: queue.followUp.map((text) => ({ text })),
  }
}
export function normalizeOmpSessionEntry(
  entry: Record<string, unknown>
): ExternalAgentSessionEntry {
  if (typeof entry.id !== "string" || !entry.id || typeof entry.type !== "string")
    throw new Error("OMP session entry requires an id and type")
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined
  const message = record(entry.message)
  let mappedMessage: ExternalAgentMessage | undefined
  if (
    message &&
    (message.role === "user" ||
      message.role === "assistant" ||
      message.role === "system" ||
      message.role === "toolResult")
  ) {
    const rawContent =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : []
    const content: ExternalAgentContent[] = rawContent.flatMap((value): ExternalAgentContent[] => {
      const block = record(value)
      if (block?.type === "text" && typeof block.text === "string")
        return [{ type: "text", text: block.text }]
      if (block?.type === "thinking" && typeof block.thinking === "string")
        return [{ type: "thinking", thinking: block.thinking }]
      if (
        block?.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      )
        return [
          {
            type: "image",
            source: { type: "base64", data: block.data, mediaType: block.mimeType },
          },
        ]
      if (
        block?.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      )
        return [
          {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: record(block.arguments) ?? {},
          },
        ]
      return []
    })
    const date = new Date(
      timestamp ?? (typeof message.timestamp === "number" ? message.timestamp : 0)
    )
    mappedMessage = {
      id: entry.id,
      role: message.role === "toolResult" ? "tool" : message.role,
      content,
      timestamp: Number.isNaN(date.getTime()) ? new Date(0) : date,
      tokenUsage: ompStatsToTokenUsage({ usage: message.usage }),
      metadata: { ...message },
    }
  }
  return {
    id: entry.id,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    type: entry.type,
    timestamp,
    message: mappedMessage,
    ...(entry.type === "message"
      ? { forkAt: { kind: "entry" as const, id: entry.id, boundary: "through" as const } }
      : {}),
    metadata: { ...entry },
  }
}
