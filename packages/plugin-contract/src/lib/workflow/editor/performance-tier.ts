/**
 * The plugin contract's share of `lib/workflow/editor/performance-tier.ts`, which re-exports these.
 */
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
