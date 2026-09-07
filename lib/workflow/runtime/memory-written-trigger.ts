/**
 * `trigger.memory.written` runner (ADR-0069).
 *
 * Subscribes `lib/memory/memory-event-bus.ts`, published by `createMemory`
 * after the row lands. That is the complete chokepoint for a new memory:
 * every surface (the `action.memory.store` node, `ctx.memory.store`, the MCP
 * tool, the companion RPC, turn extraction, project mining) funnels through
 * it, and the consolidator's `ADD` op reaches it through the same extraction
 * writer it uses as its `persist` dependency.
 *
 * Self-feed protection has two independent legs, because neither alone is
 * enough:
 *
 *  1. The run-window drop. `dispatchTrigger` awaits the whole run, so every
 *     memory written *during* a run this trigger started is dropped by the
 *     in-flight guard, whichever surface wrote it. This leg does not require
 *     the writer to cooperate or even to be enumerable.
 *  2. Origin self-rejection, for the write a run *queued* that lands after it
 *     ended (the memory job worker draining an extraction job). The origin
 *     rides the event only, so it costs no column.
 *
 * The payload never carries `text`. See the bus module for why.
 */

import { loggers } from "@cognia/logging"
import type { MemoryWrittenEvent } from "@/lib/memory/memory-event-bus"
import {
  createFanOutState,
  disposeFanOut,
  fanOutTrigger,
  type TriggerFanOutState,
} from "./trigger-fan-out"

const log = loggers.scheduler

let state: TriggerFanOutState | null = null

async function onMemoryWritten(event: MemoryWrittenEvent): Promise<void> {
  const s = state
  if (!s || !s.active) return
  try {
    await fanOutTrigger({
      state: s,
      kind: "trigger.memory.written",
      match: {
        memoryType: event.type,
        memoryScope: event.scope,
        memoryProvenance: event.provenance,
        importance: event.importance,
        memoryKey: event.key,
        characterId: event.characterId,
        projectId: event.projectId,
        agentId: event.agentId,
      },
      payload: {
        memoryId: event.memoryId,
        type: event.type,
        scope: event.scope,
        provenance: event.provenance,
        importance: event.importance,
        sourceChannel: event.sourceChannel,
        characterId: event.characterId,
        projectId: event.projectId,
        agentId: event.agentId,
        key: event.key,
        at: event.at,
        chainDepth: event.origin?.chainDepth ?? 0,
      },
      reject: (workflowId) =>
        event.origin?.workflowId === workflowId ? "it wrote this memory" : null,
    })
  } catch (error) {
    log.warn("memory-written-trigger: dispatch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function initMemoryWrittenTrigger(deps: { now?: () => number } = {}): void {
  if (typeof window === "undefined") return
  disposeMemoryWrittenTrigger()
  const s = createFanOutState(deps.now ?? Date.now)
  state = s
  void import("@/lib/memory/memory-event-bus")
    .then(({ onMemoryWritten: subscribe }) => {
      if (!state || state !== s || !s.active) return
      s.unsubscribe = subscribe((event) => void onMemoryWritten(event))
    })
    .catch((error) => {
      log.warn("memory-written-trigger: subscribe failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

export function disposeMemoryWrittenTrigger(): void {
  disposeFanOut(state)
  state = null
}

/** Test-only: drive one event through the runner without the live bus. */
export async function _injectMemoryWrittenForTest(event: MemoryWrittenEvent): Promise<void> {
  await onMemoryWritten(event)
}
