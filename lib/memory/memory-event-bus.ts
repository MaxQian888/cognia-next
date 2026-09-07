/**
 * In-process fan-out of long-term memory writes (ADR-0069).
 *
 * `lib/db/memories.ts:createMemory` publishes here after the row lands. That
 * is the complete chokepoint for a *new* memory: the degraded branch of
 * `storeMemoryCore`, turn extraction, and project mining all funnel through
 * it, and the consolidator's `ADD` op reaches it through the same extraction
 * writer it uses as its `persist` dependency.
 *
 * Scope, stated rather than implied: this fires when a memory is CREATED.
 * Consolidator `UPDATE` / `SUPERSEDE` / `CONFLICT` ops go through
 * `updateMemory` / `invalidateMemory` and do not fire it. That is the natural
 * second chokepoint if a `revised` kind is ever wanted, and adding it now
 * would double the event volume for a case nobody has asked for.
 *
 * The payload deliberately carries no `text`. Long-term memory text is, by
 * construction, durable facts about the user, and there is no safe subset of
 * it to gate. Ids and classification only. A workflow that needs the content
 * reads it back with `action.memory.recall`, which re-enters the memory read
 * gate that a trigger payload would otherwise bypass.
 */

import type { Memory } from "@cognia/memory"

const EVENT_NAME = "memory:written"
const bus: EventTarget = new EventTarget()

/** Where a workflow-authored write came from, so the runner can reject itself. */
export interface MemoryWriteOrigin {
  workflowId?: string
  runId?: string
  chainDepth?: number
}

export interface MemoryWrittenEvent {
  memoryId: string
  type: Memory["type"]
  scope: Memory["scope"]
  provenance: Memory["provenance"]
  importance: number
  sourceChannel?: string
  characterId?: string
  projectId?: string
  agentId?: string
  /** The author's dedupe slug, which is a chosen key and not extracted text. */
  key?: string
  at: number
  origin?: MemoryWriteOrigin
}

export type MemoryWrittenListener = (event: MemoryWrittenEvent) => void

export function emitMemoryWritten(event: MemoryWrittenEvent): void {
  bus.dispatchEvent(new CustomEvent<MemoryWrittenEvent>(EVENT_NAME, { detail: event }))
}

export function onMemoryWritten(handler: MemoryWrittenListener): () => void {
  const listener = (raw: Event) => {
    const event = (raw as CustomEvent<MemoryWrittenEvent>).detail
    if (!event) return
    try {
      handler(event)
    } catch (error) {
      console.error(
        `[memory/memory-event-bus] handler threw for ${event.memoryId}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  bus.addEventListener(EVENT_NAME, listener)
  return () => bus.removeEventListener(EVENT_NAME, listener)
}
