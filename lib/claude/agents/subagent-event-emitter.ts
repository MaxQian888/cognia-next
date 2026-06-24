/**
 * Gap 1 producer: maps the executor's per-event `CaptureStreamEvent` stream
 * (already emitted by `run-and-capture.ts`, previously dropped before the
 * `dispatch_agent` path) into live `subagent-runtime-store` updates so a running
 * subagent shows incremental logs + moving progress instead of a 0→100 jump.
 *
 * `makeSubagentEmitter` returns a stateful closure (per dispatched run) because
 * streaming text must coalesce into a single growing log line. Best-effort: a
 * throw here must never disturb the capture loop, so every store touch is guarded.
 */

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

/** Heuristic monotonic progress toward a 95% asymptote (no real total exists). */
export function nudgeProgress(current: number): number {
  return Math.min(95, current + (95 - current) * 0.15)
}

export function makeSubagentEmitter(id: string): (event: CaptureStreamEvent) => void {
  let streamedText = ""
  return (event) => {
    try {
      const store = useSubagentRuntimeStore.getState()
      if (!store.subAgents[id]) return
      switch (event.type) {
        case "tool-call":
          store.appendLog(id, {
            timestamp: new Date(),
            level: "info",
            message: event.toolName,
            data: event.input,
          })
          break
        case "tool-result": {
          store.appendLog(id, {
            timestamp: new Date(),
            level: event.isError ? "error" : "info",
            message: event.toolName,
            data: event.result,
          })
          const cur = store.subAgents[id]?.progress ?? 0
          store.setProgress(id, nudgeProgress(cur))
          break
        }
        case "text-delta":
          streamedText += event.delta
          store.pushStreamText(id, streamedText)
          break
        case "thinking-delta":
        case "usage":
        case "compact":
        default:
          break
      }
    } catch {
      // Best-effort: never let a store error break the capture loop.
    }
  }
}
