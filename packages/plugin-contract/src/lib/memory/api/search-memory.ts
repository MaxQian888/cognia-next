/**
 * The plugin contract's share of `lib/memory/api/search-memory.ts`, which re-exports these.
 */
import type { Memory } from "../../../types/memory/memory"

export interface ExternalMemoryHit {
  memory: Memory
  /** Normalized fused relevance in [0,1]. */
  relevance: number
  /** Combined multi-factor score. */
  score: number
}
