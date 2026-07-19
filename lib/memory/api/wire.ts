/**
 * Wire projection for memory rows crossing an external API boundary (MCP
 * bridge tools, companion RPC). Strips internal plumbing (`vectorDocId`,
 * access counters, supersession links, attribution internals) so external
 * callers see a stable, minimal shape.
 */

import type { Memory, MemoryScope, MemoryType } from "@/types/memory/memory"

export interface MemoryWireRow {
  id: string
  text: string
  type: MemoryType
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  importance: number
  tags: string[]
  pinned: boolean
  provenance: Memory["provenance"]
  createdAt: number
  updatedAt: number
}

export function toMemoryWireRow(m: Memory): MemoryWireRow {
  return {
    id: m.id,
    text: m.text,
    type: m.type,
    scope: m.scope,
    ...(m.characterId ? { characterId: m.characterId } : {}),
    ...(m.projectId ? { projectId: m.projectId } : {}),
    ...(m.agentId ? { agentId: m.agentId } : {}),
    ...(m.branch ? { branch: m.branch } : {}),
    ...(m.pathPattern ? { pathPattern: m.pathPattern } : {}),
    importance: m.importance,
    tags: m.tags,
    pinned: m.pinned,
    provenance: m.provenance,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}
