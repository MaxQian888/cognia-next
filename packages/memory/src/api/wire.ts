/**
 * Wire projection for memory rows crossing an external API boundary (MCP
 * bridge tools, companion RPC). Strips internal plumbing (`vectorDocId`,
 * access counters, supersession links, attribution internals) so external
 * callers see a stable, minimal shape.
 */

import type { Memory, MemoryScope, MemoryType } from "../types/memory"

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
  /**
   * Content version — external callers feed it back as `expectedVersion` for
   * compare-and-swap updates. Not an auth token: it only proves the caller saw
   * the row.
   */
  version: number
  createdAt: number
  updatedAt: number
  /**
   * Present only on a historical (`asOf`) hit whose text was an earlier
   * wording: the snapshot's own id. `id` is always the memory's id, so a caller
   * that acts on a hit acts on the memory, never on a piece of its history.
   */
  revisionId?: string
  /** When this text became the memory's text (historical hits). */
  validFrom?: number
  /** When this text stopped being the memory's text; absent while it still is. */
  validTo?: number
}

export function toMemoryWireRow(m: Memory): MemoryWireRow {
  const isRevision = m.revisionOf !== undefined
  return {
    id: m.revisionOf ?? m.id,
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
    version: m.version,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    ...(isRevision ? { revisionId: m.id } : {}),
    ...(isRevision || m.revisedAt !== undefined ? { validFrom: m.revisedAt ?? m.createdAt } : {}),
    ...(m.status === "invalidated" && m.invalidatedAt !== undefined
      ? { validTo: m.invalidatedAt }
      : {}),
  }
}
