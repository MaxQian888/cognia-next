/**
 * `/memory` and `/remember` for the TUI.
 *
 * The writes used to call `createMemory` and `hardDeleteMemory` straight from
 * `lib/db/memories`, which meant the CLI was the one surface with no PII gate,
 * no agent policy, no consolidator (so no dedupe or supersede), no evidence, no
 * audit row and no vector upsert. They now go through the same canonical funnel
 * the desktop uses.
 *
 * `/remember` pins `scope: "global"` on purpose. The shared resolver's fallback
 * ladder would otherwise land a CLI capture in the active workspace, which is a
 * silent relocation of where CLI memories have always lived.
 *
 * Recall is still listing rather than similarity search here, but the reason is
 * now read from the runtime instead of asserted: on a non-Tauri host the native
 * vector provider is gated, so the honest answer is keyword-only.
 */
import { getMemory, listMemories } from "@/lib/db/memories"
import { getSettings } from "@/lib/db/settings"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import {
  describeMemoryRetrievalMode,
  type MemoryRetrievalMode,
} from "@/lib/memory/runtime/build-deps"
import { rememberFact, type RememberFactResult } from "@/lib/memory/write/remember-fact"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type { Memory } from "@/types/memory/memory"

import { ensureCliDb } from "../../db/bootstrap"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface MemoryDeps {
  dispatch: (action: TuiAction) => void
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Memory[]>
  get?: (id: string) => Promise<Memory | undefined>
  /** Persist a new memory. Defaults to the canonical explicit-capture funnel. */
  add?: (text: string) => Promise<RememberFactResult>
  /** Delete a memory by id. Defaults to the audited control-plane delete. */
  remove?: (id: string) => Promise<{ ok: boolean; reason?: string }>
  /** What recall would actually do on this host. */
  describeMode?: () => Promise<MemoryRetrievalMode>
}

const dbOf = (d: MemoryDeps) => d.ensureDb ?? (() => ensureCliDb())

async function defaultDescribeMode(): Promise<MemoryRetrievalMode> {
  const settings = await getSettings().catch(() => undefined)
  return describeMemoryRetrievalMode(resolveMemoryConfig(settings?.memory))
}

/** One sentence naming the recall mode, and why, without inventing a reason. */
function describeRecall(mode: MemoryRetrievalMode): string {
  if (mode.kind === "off") {
    return mode.reason === "temporary"
      ? "Memory is paused by temporary mode. Showing what is already stored."
      : "Long-term memory is turned off. Showing what is already stored."
  }
  if (mode.kind === "hybrid") {
    return `Hybrid recall is available via ${mode.provider}. Showing stored memories.`
  }
  const why: Record<typeof mode.reason, string> = {
    hybrid_disabled: "hybrid recall is turned off",
    no_backend: "no embedding or vector backend is reachable from the CLI",
    store_unsupported: "the configured vector store cannot search by embedding",
    cloud_blocked: "cloud embedding is not permitted",
  }
  return `Recall is keyword-only because ${why[mode.reason]}. Showing stored memories.`
}

export async function memoryList(deps: MemoryDeps): Promise<void> {
  await dbOf(deps)()
  const rows = await (deps.list ?? (() => listMemories()))()
  if (rows.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No memories stored." })
    return
  }
  const mode = await (deps.describeMode ?? defaultDescribeMode)().catch(
    (): MemoryRetrievalMode => ({ kind: "bm25", reason: "no_backend" })
  )
  deps.dispatch({ type: "NOTICE", message: describeRecall(mode) })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Stored memories",
      items: rows.map((m) => ({ id: m.id, label: truncate(m.text), hint: m.type })),
      index: 0,
      onSelectCommand: "memory show",
    },
  })
}

export async function memoryShow(id: string, deps: MemoryDeps): Promise<void> {
  await dbOf(deps)()
  const memory = await (deps.get ?? getMemory)(id)
  if (!memory) {
    deps.dispatch({ type: "NOTICE", message: `Memory ${id} not found.` })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `[${memory.type}] ${memory.text}` })
}

/** Copy for each way the canonical funnel can refuse a deliberate capture. */
const ADD_REFUSAL: Record<string, string> = {
  disabled: "Long-term memory is turned off, so nothing was saved.",
  temporary: "Temporary mode is on, so nothing was saved.",
  pii: "That looks like it contains sensitive data, so it was not saved.",
  denied: "This agent is not allowed to write memory in that scope.",
  unavailable: "The memory store is unavailable right now.",
  failed: "Something went wrong saving that to memory.",
}

/**
 * Save a user-captured fact to long-term memory (`/remember`, `/memory add`).
 * Provenance is `explicit`, the same trust class the desktop capture uses, so
 * the fact may become a procedural rule.
 */
export async function memoryAdd(text: string, deps: MemoryDeps): Promise<void> {
  const body = text.trim()
  if (!body) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /remember <text>" })
    return
  }
  await dbOf(deps)()
  const add = deps.add ?? ((t: string) => rememberFact({ text: t, scope: "global" }))
  const result = await add(body)
  if (!result.ok) {
    deps.dispatch({
      type: "NOTICE",
      message: ADD_REFUSAL[result.reason] ?? "Something went wrong saving that to memory.",
    })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Remembered: ${truncate(body)}` })
}

/** Delete a stored memory by id (`/memory delete <id>`). */
export async function memoryDelete(id: string, deps: MemoryDeps): Promise<void> {
  const key = id.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /memory delete <id>" })
    return
  }
  await dbOf(deps)()
  const get = deps.get ?? getMemory
  const existing = await get(key)
  if (!existing) {
    deps.dispatch({ type: "NOTICE", message: `Memory ${key} not found.` })
    return
  }
  const remove = deps.remove ?? ((target: string) => manageMemory({ kind: "delete", id: target }))
  const result = await remove(key)
  if (!result.ok) {
    deps.dispatch({
      type: "NOTICE",
      message: `Could not delete memory ${key} (${result.reason ?? "failed"}).`,
    })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Deleted memory ${key}.` })
}
