/**
 * Renderer side of the code-level protocol-adapter round-trip (P2-E).
 *
 * The sidecar's code-adapter emits `protocol_adapter_exec` for a turn whose
 * provider uses a plugin code adapter. This module resolves the plugin's
 * executor (registered by the protocol-adapters bridge), runs it, and streams
 * each AI-SDK-shaped chunk back to the sidecar as `protocol_adapter_chunk`,
 * closing with `protocol_adapter_done` (usage harvested from a `finish`
 * chunk) or `protocol_adapter_error`. Plugin code runs HERE — never in the
 * sidecar process.
 */

import { getCodeAdapterExecutor } from "@/lib/ai/providers/protocol-adapter-registry"
import type { CodeAdapterChunk, CodeAdapterRequest } from "@/types/plugin/plugin-protocol-adapter"

export interface ProtocolAdapterExecEvent {
  sessionId: string
  execId: string
  pluginId: string
  adapterId: string
  request: CodeAdapterRequest
}

/** Writes a command line back to the sidecar (claude-host stdin). */
export type SidecarCommandWriter = (msg: Record<string, unknown>) => void | Promise<void>

interface DispatchDeps {
  writeCommand: SidecarCommandWriter
  /** Override the executor lookup (tests). */
  resolveExecutor?: typeof getCodeAdapterExecutor
}

/**
 * Run one code-adapter execution and stream chunks back. Never throws into the
 * caller — a missing executor or a thrown stream surfaces as
 * `protocol_adapter_error` so the sidecar fails the turn cleanly.
 */
export async function dispatchProtocolAdapterExec(
  event: ProtocolAdapterExecEvent,
  deps: DispatchDeps
): Promise<void> {
  const { sessionId, execId } = event
  const resolve = deps.resolveExecutor ?? getCodeAdapterExecutor
  const factory = resolve(event.adapterId)
  if (!factory) {
    await deps.writeCommand({
      type: "protocol_adapter_error",
      sessionId,
      execId,
      error: `no code adapter registered for "${event.adapterId}"`,
    })
    return
  }

  let usage: Record<string, number> | undefined
  try {
    const executor = await factory({ adapterId: event.adapterId, pluginId: event.pluginId })
    for await (const chunk of executor.stream(event.request)) {
      const c = chunk as CodeAdapterChunk
      if (c.type === "finish" && "usage" in c && c.usage) {
        usage = c.usage as Record<string, number>
      }
      if (c.type === "error") {
        await deps.writeCommand({
          type: "protocol_adapter_error",
          sessionId,
          execId,
          error: String((c as { error?: unknown }).error ?? "code adapter error"),
        })
        return
      }
      await deps.writeCommand({ type: "protocol_adapter_chunk", sessionId, execId, chunk: c })
    }
    await deps.writeCommand({
      type: "protocol_adapter_done",
      sessionId,
      execId,
      ...(usage ? { usage } : {}),
    })
  } catch (err) {
    await deps.writeCommand({
      type: "protocol_adapter_error",
      sessionId,
      execId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
