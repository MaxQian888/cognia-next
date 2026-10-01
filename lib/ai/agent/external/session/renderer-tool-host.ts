import type { PermissionRequestEvent, SendOptions, ToolHostEvent } from "@cognia/agent-config-types"
import { callSidecarToolHost, createSidecarFeatureCallClient } from "@/lib/claude/feature-call"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { dispatchPostToolUse, dispatchPreToolUse } from "@/lib/claude/adapter-hooks"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import { transport } from "@/lib/tauri"
import {
  getActiveRemoteTransport,
  getActiveRemoteEndpoint,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
import { activeHostFeatureManifest } from "@/stores/remote-host/remote-host-store"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import type { AcpMcpServerConfig, ExternalAgentEvent } from "@/types/agent/external-agent"

export const RENDERER_TOOL_HOST_APPROVAL_PREFIX = "external-tool-host:"

export interface RendererToolHostStartOptions {
  agentId?: string
  /** Reserve plugins for a task-owned child that has not spawned yet. */
  deferSandbox?: boolean
  sendOptions: SendOptions
  signal?: AbortSignal
  onPermissionRequest?: (
    request: PermissionRequestEvent,
    signal: AbortSignal
  ) => Promise<CapturePermissionDecision>
  onToolEvent?: (event: ExternalAgentEvent) => void
}

export interface RendererToolHost {
  isCurrentHost(): boolean
  start(options: RendererToolHostStartOptions): Promise<{
    mcpServers: AcpMcpServerConfig[]
    catalogFingerprint: string
    sandboxToolHostLeaseId?: string
  }>
  pause(): Promise<void>
  close(): Promise<void>
}

interface Dependencies {
  call: typeof callSidecarToolHost
  subscribe: (handler: (event: ToolHostEvent) => void) => (() => void) | Promise<() => void>
  execute: typeof handlePluginToolExec
  review: typeof dispatchPostToolUse
  before: typeof dispatchPreToolUse
  randomUUID: () => string
}

function serverConfigs(value: unknown, leaseId: string, deferredSandbox: boolean) {
  const result = value as {
    leaseId?: string
    mcpServers?: unknown[]
    generation?: number
    catalogFingerprint?: string
    sandboxToolHostLeaseId?: unknown
  } | null
  if (
    result?.leaseId !== leaseId ||
    !Array.isArray(result.mcpServers) ||
    !Number.isSafeInteger(result.generation) ||
    result.generation! < 1 ||
    typeof result.catalogFingerprint !== "string" ||
    !result.catalogFingerprint
  ) {
    throw new Error("Cognia tool host returned an invalid lease")
  }
  const sandboxToolHostLeaseId = result.sandboxToolHostLeaseId
  if (
    (deferredSandbox || sandboxToolHostLeaseId !== undefined) &&
    (typeof sandboxToolHostLeaseId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        sandboxToolHostLeaseId
      ))
  )
    throw new Error("Cognia tool host returned an invalid sandbox plugin lease; update the Host")
  const mcpServers: AcpMcpServerConfig[] = result.mcpServers.map((value) => {
    const server = value as {
      name?: string
      transport?: string
      url?: string
      headers?: Record<string, string>
    }
    let url: URL
    try {
      url = new URL(server.url ?? "")
    } catch {
      throw new Error("Cognia tool host returned an invalid endpoint")
    }
    if (
      server.transport !== "http" ||
      !["cognia-tools", "cognia-plugin-tools"].includes(server.name ?? "") ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      !server.headers ||
      Object.values(server.headers).some((header) => typeof header !== "string")
    ) {
      throw new Error("Cognia tool host returned an invalid endpoint")
    }
    return {
      type: "http",
      name: server.name!,
      url: url.href,
      headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
    }
  })
  return {
    mcpServers,
    generation: result.generation!,
    catalogFingerprint: result.catalogFingerprint,
    ...(typeof sandboxToolHostLeaseId === "string" ? { sandboxToolHostLeaseId } : {}),
  }
}

/** A conversation keeps one endpoint; each turn supplies fresh tools and authority. */
export function createRendererToolHost(
  ownerSessionId: string,
  overrides: Partial<Dependencies> = {}
): RendererToolHost {
  const remote = getActiveRemoteTransport()
  if (
    remote &&
    !supportsHostFeatureOperation(
      activeHostFeatureManifest(),
      "external-agent.process-plane",
      "agent_tool_host_control"
    )
  )
    throw new Error("This Host does not support Cognia plugin tool hosting; update the Host")
  const deviceId = remote ? getActiveRemoteEndpoint()?.deviceId : undefined
  if (remote && !deviceId) throw new Error("Remote tool host requires a paired device identity")
  const remoteSubscriptions = new Set<() => void>()
  const assertTarget = () => {
    if (
      getActiveRemoteTransport() !== remote ||
      (remote && getActiveRemoteEndpoint()?.deviceId !== deviceId)
    )
      throw new Error("Cognia tool host belongs to a different Host")
  }
  const remoteSubscribe = async (event: string, handler: (payload: never) => void) => {
    assertTarget()
    const off = remote!.subscribe(event, (payload) => {
      if (getActiveRemoteTransport() === remote) handler(payload as never)
    })
    remoteSubscriptions.add(off)
    try {
      const ready = (
        remote as typeof remote & {
          whenSubscribed?: (channels: readonly string[]) => Promise<void>
        }
      )?.whenSubscribed
      if (ready) await ready.call(remote, [event])
      assertTarget()
      return () => {
        off()
        remoteSubscriptions.delete(off)
      }
    } catch (error) {
      off()
      remoteSubscriptions.delete(off)
      throw error
    }
  }
  const remoteClient = remote
    ? createSidecarFeatureCallClient({
        call: async (command, args) => {
          assertTarget()
          if (command !== "claude_feature_call")
            throw new Error("Unsupported remote tool host command")
          const result = await remote.call("agent_tool_host_control", args)
          assertTarget()
          return result
        },
        subscribe: remoteSubscribe,
        randomUUID: () => crypto.randomUUID(),
      })
    : undefined
  const stopWatching = remote
    ? subscribeActiveRemoteTransport((next) => {
        if (next !== remote) {
          deactivate()
          if (heartbeat) clearInterval(heartbeat)
          remoteClient?.dispose(new Error("Cognia tool host Host changed"))
          for (const off of remoteSubscriptions) off()
          remoteSubscriptions.clear()
        }
      })
    : undefined
  const deps: Dependencies = {
    call: remoteClient
      ? (operation, control) => callSidecarToolHost(operation, control, remoteClient.requestResult)
      : callSidecarToolHost,
    subscribe: (handler) =>
      remote
        ? remoteSubscribe("claude://message", handler)
        : transport.subscribe("claude://message", handler),
    execute: handlePluginToolExec,
    review: dispatchPostToolUse,
    before: dispatchPreToolUse,
    randomUUID: () => crypto.randomUUID(),
    ...overrides,
  }
  const leaseId = `${remote ? `remote-tool-host:${deviceId}:` : ""}${deps.randomUUID()}`
  const identity = { leaseId, ownerSessionId }
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let active:
    | {
        controller: AbortController
        options: RendererToolHostStartOptions
        seen: Set<string>
        pending: Map<string, AbortController>
        detach: () => void
        generation: number
      }
    | undefined
  let closed = false
  let opened = false
  let queue = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function deactivate() {
    const prior = active
    active = undefined
    prior?.detach()
    prior?.controller.abort()
  }

  async function receive(envelope: ToolHostEvent) {
    if (
      envelope.type !== "tool_host_event" ||
      envelope.leaseId !== leaseId ||
      envelope.sessionId !== ownerSessionId
    )
      return
    const event = envelope.event
    if (event.sessionId !== ownerSessionId) return
    const turn = active
    if (!turn || closed || turn.generation !== envelope.generation) return
    if (event.type === "tool_host_cancel") {
      deactivate()
      return
    }
    if (event.type === "tool_host_call_cancel") {
      turn.pending.get(`${event.kind}:${event.id}`)?.abort()
      return
    }
    const kind =
      event.type === "permission_request"
        ? "permission"
        : event.type === "plugin_tool_exec"
          ? "plugin"
          : event.type === "tool_result_review"
            ? "review"
            : event.type === "tool_host_pre_tool"
              ? "preflight"
              : undefined
    if (!kind) return
    const id =
      event.type === "permission_request" || event.type === "tool_host_pre_tool"
        ? event.requestId
        : event.type === "tool_result_review"
          ? event.reviewId
          : event.toolUseId
    const key = `${kind}:${id}`
    if (turn.seen.has(key)) return
    turn.seen.add(key)
    const controller = new AbortController()
    const abort = () => controller.abort()
    turn.controller.signal.addEventListener("abort", abort, { once: true })
    turn.pending.set(key, controller)
    try {
      let result: unknown
      if (event.type === "tool_host_pre_tool") {
        try {
          result = await deps.before(event.toolName, event.input, ownerSessionId)
        } catch {
          result = { action: "deny", reason: "Cognia tool preflight failed" }
        }
      } else if (event.type === "tool_result_review") {
        try {
          const review = await deps.review(
            event.toolName,
            event.input ?? {},
            event.result,
            ownerSessionId
          )
          result = { updatedResult: review.modifiedResult }
        } catch {
          result = {}
        }
      } else if (event.type === "permission_request") {
        try {
          const decision = await turn.options.onPermissionRequest?.(
            { ...event, requestId: `${RENDERER_TOOL_HOST_APPROVAL_PREFIX}${leaseId}:${id}` },
            controller.signal
          )
          result =
            decision?.decision === "allow" || decision?.decision === "allow_always"
              ? { behavior: "allow", updatedInput: decision.updatedInput ?? event.input }
              : {
                  behavior: "deny",
                  message: decision?.message ?? "Cognia tool permission denied",
                }
        } catch {
          result = { behavior: "deny", message: "Cognia tool permission denied" }
        }
      } else {
        const toolUseId = `${RENDERER_TOOL_HOST_APPROVAL_PREFIX}${leaseId}:${id}`
        const publish = (payload: ExternalAgentEvent) => {
          try {
            turn.options.onToolEvent?.(payload)
          } catch {
            /* Presentation cannot prevent the tool reply. */
          }
        }
        publish({
          type: "tool_use_start",
          sessionId: ownerSessionId,
          timestamp: new Date(),
          toolUseId,
          toolName: event.name,
          rawInput: event.args,
        })
        publish({
          type: "tool_use_end",
          sessionId: ownerSessionId,
          timestamp: new Date(),
          toolUseId,
          input: event.args,
        })
        try {
          result = await deps.execute({ ...event, abortSignal: controller.signal })
        } catch {
          result = { error: "Cognia tool execution failed" }
        }
        if (active === turn && !controller.signal.aborted) {
          const response = result as { result?: unknown; error?: string }
          publish({
            type: "tool_result",
            sessionId: ownerSessionId,
            timestamp: new Date(),
            toolUseId,
            result:
              response.error ??
              (typeof response.result === "string"
                ? response.result
                : JSON.stringify(response.result ?? null)),
            isError: Boolean(response.error),
          })
        }
      }
      // A paused generation must never authorize a later turn or return stale output.
      if (active === turn && !controller.signal.aborted) {
        await deps.call("tool-host-reply", {
          ...identity,
          generation: turn.generation,
          kind,
          id,
          result,
        })
      }
    } finally {
      turn.pending.delete(key)
      turn.controller.signal.removeEventListener("abort", abort)
    }
  }

  const host: RendererToolHost = {
    isCurrentHost: () => !closed && getActiveRemoteTransport() === remote,
    start(options) {
      return enqueue(async () => {
        if (closed) throw new Error("Cognia tool host is closed")
        assertTarget()
        const sandbox = Boolean(
          options.sendOptions.sandboxRuntimeRef ||
          (options.agentId && spawnPlacementFor(options.agentId))
        )
        const deferredSandbox = sandbox && options.deferSandbox === true
        if (
          sandbox &&
          (!options.agentId ||
            (remote &&
              !supportsHostFeatureOperation(
                activeHostFeatureManifest(),
                "external-agent.sandbox-tools",
                "agent_tool_host_control"
              )))
        )
          throw new Error(
            "This Host does not support sandbox hosted tools; update the Host and agent bundle"
          )
        options.signal?.throwIfAborted()
        if (active) throw new Error("Pause the Cognia tool host before starting another turn")
        unsubscribe ??= await deps.subscribe((event) => {
          void receive(event).catch(() => undefined)
        })
        const controller = new AbortController()
        const abort = () => {
          void host.pause().catch(() => undefined)
        }
        const turn = (active = {
          controller,
          options,
          seen: new Set(),
          pending: new Map(),
          generation: 0,
          detach: () => options.signal?.removeEventListener("abort", abort),
        })
        options.signal?.addEventListener("abort", abort, { once: true })
        try {
          // Do not abort the start request itself: wait for its descriptor, then revoke it.
          const response = await deps.call("tool-host-start", {
            ...identity,
            ...(sandbox ? { sandboxAgentId: options.agentId } : {}),
            ...(deferredSandbox ? { deferSandbox: true } : {}),
            // Remote plugin tools execute through the renderer's existing
            // permission/PII gate. Host builtins stay with the native agent;
            // forwarding their cwd/sandbox options would create another exec path.
            sendOptions:
              remote || sandbox
                ? {
                    pluginTools: options.sendOptions.pluginTools,
                    permissionMode: options.sendOptions.permissionMode,
                    permissionRuleset: options.sendOptions.permissionRuleset,
                    allowedTools: options.sendOptions.allowedTools,
                    disallowedTools: options.sendOptions.disallowedTools,
                    toolResultReviewEnabled: options.sendOptions.toolResultReviewEnabled,
                  }
                : options.sendOptions,
          })
          opened = true
          const { mcpServers, generation, catalogFingerprint, sandboxToolHostLeaseId } =
            serverConfigs(response, leaseId, deferredSandbox)
          turn.generation = generation
          if (closed || options.signal?.aborted || controller.signal.aborted)
            throw new DOMException("Cognia tool host start aborted", "AbortError")
          heartbeat ??= setInterval(() => {
            void enqueue(async () => {
              if (!opened || closed) return
              try {
                await deps.call("tool-host-start", { ...identity, renew: true })
              } catch {
                deactivate()
              }
            })
          }, 60_000)
          return {
            mcpServers,
            catalogFingerprint,
            ...(sandboxToolHostLeaseId ? { sandboxToolHostLeaseId } : {}),
          }
        } catch (error) {
          deactivate()
          await deps.call("tool-host-stop", identity).catch(() => undefined)
          opened = false
          throw error
        }
      })
    },
    pause() {
      deactivate()
      return enqueue(async () => {
        if (opened) await deps.call("tool-host-stop", { ...identity, pause: true })
      })
    },
    close() {
      closed = true
      deactivate()
      if (heartbeat) clearInterval(heartbeat)
      return enqueue(async () => {
        try {
          if (opened && (!remote || getActiveRemoteTransport() === remote))
            await deps.call("tool-host-stop", identity)
          opened = false
        } finally {
          unsubscribe?.()
          unsubscribe = undefined
          remoteClient?.dispose()
          stopWatching?.()
          for (const off of remoteSubscriptions) off()
          remoteSubscriptions.clear()
        }
      })
    },
  }
  return host
}
