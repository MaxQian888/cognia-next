/**
 * Performance-tier resolver for the visual workflow editor.
 *
 * `PerformanceTier` is the user-facing knob (auto / high / balanced / reduced).
 * `EffectivePerfFlags` is the consumed surface — every motion-bearing feature
 * reads from a single flag set instead of branching on tier strings.
 *
 * `auto` resolution rules (priority order):
 *   1. OS prefers-reduced-motion → `reduced`.
 *   2. Workflow has ≥ AUTO_BALANCED_THRESHOLD nodes → `balanced`.
 *   3. Otherwise → `high`.
 *
 * Explicit non-auto tiers always win, so a user override (e.g. `high` on a
 * tiny graph, or `reduced` even without OS-level reduce-motion) is honoured.
 */

export type PerformanceTier = "auto" | "high" | "balanced" | "reduced"

export type ResolvedPerformanceTier = Exclude<PerformanceTier, "auto">

/**
 * Node-count above which `auto` chooses `balanced`. Tuned to the point where
 * minimap repaint + alignment-guide overhead starts to matter on mid-range
 * laptops. Exposed so tests don't depend on a magic constant.
 */
export const AUTO_BALANCED_THRESHOLD = 80

export interface EffectivePerfFlags {
  /** Render the React Flow `<MiniMap>` at all. */
  showMinimap: boolean
  /** Strip listeners + use a flat node colour on the minimap. */
  minimapDegraded: boolean
  /** Animate edges (dashed-draw, pulse on hover). */
  edgeAnimations: boolean
  /** Compute alignment guides while dragging. */
  alignmentGuides: boolean
  /** Keep Dexie liveQuery active while a node is being dragged. */
  liveQueryWhileDragging: boolean
  /** Re-validate inspector forms on every keystroke. */
  inspectorLiveValidation: boolean
  /** Apply CSS transitions on node card shadow/ring on hover/select. */
  nodeCardTransitions: boolean
  /**
   * Node count at which React Flow's `onlyRenderVisibleElements` kicks in.
   * Below this, the per-render measure+filter cost outweighs the savings on
   * the `high` tier; `balanced`/`reduced` always cull (threshold 0) since
   * they're already in a degraded budget.
   */
  cullingThreshold: number
}

export interface ResolveOpts {
  nodeCount: number
  prefersReducedMotion: boolean
}

export function resolveEffectiveTier(
  tier: PerformanceTier,
  opts: ResolveOpts
): ResolvedPerformanceTier {
  if (tier !== "auto") return tier
  if (opts.prefersReducedMotion) return "reduced"
  if (opts.nodeCount >= AUTO_BALANCED_THRESHOLD) return "balanced"
  return "high"
}

const FLAGS_BY_TIER: Record<ResolvedPerformanceTier, EffectivePerfFlags> = {
  high: {
    showMinimap: true,
    minimapDegraded: false,
    edgeAnimations: true,
    alignmentGuides: true,
    liveQueryWhileDragging: true,
    inspectorLiveValidation: true,
    nodeCardTransitions: true,
    cullingThreshold: 8,
  },
  balanced: {
    showMinimap: true,
    minimapDegraded: true,
    edgeAnimations: false,
    alignmentGuides: true,
    liveQueryWhileDragging: false,
    inspectorLiveValidation: true,
    nodeCardTransitions: true,
    cullingThreshold: 0,
  },
  reduced: {
    showMinimap: false,
    minimapDegraded: false,
    edgeAnimations: false,
    alignmentGuides: false,
    liveQueryWhileDragging: false,
    inspectorLiveValidation: false,
    nodeCardTransitions: false,
    cullingThreshold: 0,
  },
}

export function flagsForTier(effective: ResolvedPerformanceTier): EffectivePerfFlags {
  // Spread defensively: callers occasionally fold the result into Zustand
  // state where a leaked reference would let one consumer's mutation poison
  // the table for every subsequent caller.
  return { ...FLAGS_BY_TIER[effective] }
}

/** Type guard — useful when reading the value out of Dexie. */
export function isPerformanceTier(v: unknown): v is PerformanceTier {
  return v === "auto" || v === "high" || v === "balanced" || v === "reduced"
}
