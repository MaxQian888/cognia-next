/**
 * `/memory` controller — read-only listing of stored memories by reusing
 * `lib/db/memories`. Semantic recall (RAG via `applyTwinContext`) needs an
 * embedding provider + vector store the CLI can't reach, so v1 shows what's
 * stored without similarity search, and says so.
 */
import { getMemory, listMemories } from "@/lib/db/memories"
import type { Memory } from "@/types/memory/memory"

import { ensureCliDb } from "../../db/bootstrap"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface MemoryDeps {
  dispatch: (action: TuiAction) => void
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Memory[]>
  get?: (id: string) => Promise<Memory | undefined>
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
