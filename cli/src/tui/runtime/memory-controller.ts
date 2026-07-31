/**
 * `/memory` controller — read-only listing of stored memories by reusing
 * `lib/db/memories`. Semantic recall (RAG via `applyTwinContext`) needs an
 * embedding provider + vector store the CLI can't reach, so v1 shows what's
 * stored without similarity search, and says so.
 */
import { createMemory, getMemory, hardDeleteMemory, listMemories } from "@/lib/db/memories"
import type { Memory } from "@/types/memory/memory"

import { ensureCliDb } from "../../db/bootstrap"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface MemoryDeps {
  dispatch: (action: TuiAction) => void
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Memory[]>
  get?: (id: string) => Promise<Memory | undefined>
  /** Persist a new memory; defaults to `createMemory`. */
  add?: (text: string) => Promise<Memory>
  /** Hard-delete a memory by id; defaults to `hardDeleteMemory`. */
  remove?: (id: string) => Promise<void>
}

const dbOf = (d: MemoryDeps) => d.ensureDb ?? (() => ensureCliDb())

export async function memoryList(deps: MemoryDeps): Promise<void> {
  await dbOf(deps)()
  const rows = await (deps.list ?? (() => listMemories()))()
  if (rows.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No memories stored." })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: "Semantic recall is desktop-only; showing stored memories.",
  })
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

/**
 * Save a user-captured fact to long-term memory (`/remember` / `/memory add`).
 * Provenance is `explicit` and scope `global` — the same trust class the desktop
 * "记住 …" capture uses. Semantic recall stays desktop-only, but the fact is
 * stored and recall-eligible once an embedder is available.
 */
export async function memoryAdd(text: string, deps: MemoryDeps): Promise<void> {
  const body = text.trim()
  if (!body) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /remember <text>" })
    return
  }
  await dbOf(deps)()
  const add =
    deps.add ??
    ((t: string) =>
      createMemory({
        scope: "global",
        type: "semantic",
        text: t,
        importance: 5,
        provenance: "explicit",
      }))
  const memory = await add(body)
  deps.dispatch({ type: "NOTICE", message: `Remembered: ${truncate(memory.text)}` })
}

/** Hard-delete a stored memory by id (`/memory delete <id>`). */
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
  await (deps.remove ?? hardDeleteMemory)(key)
  deps.dispatch({ type: "NOTICE", message: `Deleted memory ${key}.` })
}
