/**
 * Per-channel declaration of which built-in skill families this adapter
 * can serve. Sits alongside `A2UICapabilityMatrix` on
 * `AdapterInstanceRow` so `lib/claude/build-options.ts:resolveSendOptions`
 * can render the capability-aware system prompt section
 *
 *   "Built-in skills available on this channel: lark.calendar (read+write),
 *    lark.doc (read+write+destructive), ..."
 *
 * without an async fan-out across the registry at every send.
 *
 * Why a parallel type instead of merging into `A2UICapabilityMatrix`?
 *
 *   - The matrix is a `Readonly<Record<A2UIComponentKind, …>>` —
 *     exhaustive over the 35 A2UI component kinds. Adding "lark.calendar"
 *     would break exhaustiveness checks and force every adapter to
 *     declare every skill family.
 *   - Skill capabilities are open-world: new families ship at any time
 *     via the built-in skill registry. The matrix is closed-world.
 *
 * Cached on `AdapterInstanceRow.lastKnownSkillCapabilities` at adapter
 * start (same write path as `lastKnownCapabilities`).
 */

/**
 * Mutation tier for a built-in skill — drives HITL routing in
 * `lib/skills/built-in/dispatcher.ts:runBuiltInSkill`:
 *
 *   - `"read"`        — no HITL, audit only
 *   - `"write"`       — A2UI confirm card by default; operators can
 *                       disable per-channel via
 *                       `ConversationOverrideRow.requireHitlForWrites`
 *   - `"destructive"` — A2UI confirm card always; channel must explicitly
 *                       opt-in via `ConversationOverrideRow.allowedBuiltInSkillIds`
 *
 * Lives in `types/connectors/` so both the platform-skill-capability
 * declaration and the built-in skill registry can import it without
 * pulling in the full skill module graph.
 */
export type BuiltInSkillMutation = "read" | "write" | "destructive"

export interface PlatformSkillCapability {
  /**
   * Family identifier matching `BuiltInSkill.family`, e.g.
   *   `"lark.calendar"`, `"lark.doc"`, `"lark.sheets"`,
   *   `"lark.base"`, `"lark.task"`, `"lark.wiki"`, `"lark.im"`.
   *
   * Cross-platform families (none in v1) share an identifier across
   * adapters that support them.
   */
  family: string
  /**
   * Mutation tiers this channel supports for the family. A family may
   * be partial — e.g. an adapter could expose `read` only because a
   * service-account credential blocks writes.
   */
  mutations: readonly BuiltInSkillMutation[]
}
