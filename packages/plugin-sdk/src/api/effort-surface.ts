/**
 * The composed reasoning-tier surface: which tiers a conversation's effort
 * control should OFFER right now, and a subscription that says when that
 * changes.
 *
 * A subpath rather than the root barrel, because these two read host stores.
 * The root publishes types and pure functions only, so a plugin that imports a
 * type from `@cognia/plugin-sdk` does not drag the settings and agent-runtime
 * stores into its module graph. That is also why they live in
 * `lib/ai/effort-surface-session` rather than beside the pure half: the barrel
 * would pick the stores up from the import alone. `resolveEffortSurface`, the
 * pure half of the same answer, stays on the root where it belongs.
 *
 * Why compose this at all instead of mapping over `THINKING_LEVELS`: the full
 * ladder is what a session MAY hold, and which tiers to offer depends on four
 * things a session row does not carry. The runtime lane executing the turn, the
 * app-level model/provider defaults behind an unpinned session, whether the
 * model reasons at all, and the user's hidden-tier preference. The host does
 * not assemble those by hand anywhere, it calls this, and a plugin that
 * re-derives them gets a different ladder from the chip sitting next to it on
 * the same toolbar.
 *
 * Both halves are needed. Reading {@link effortSurfaceForSession} once and
 * memoising it on the session row leaves the dial offering `max` and
 * `ultracode` after the conversation moved to an external agent, because three
 * of the four inputs never touch the row. {@link subscribeEffortSurface} is the
 * wake-up for exactly those, so a `useSyncExternalStore` (or a plain
 * re-render counter) tracks the same answer the composer's own hook does.
 */

export { effortSurfaceForSession, subscribeEffortSurface } from "@/lib/ai/effort-surface-session"
export type { EffortSurface, EffortSurfaceInput } from "@/lib/ai/effort-surface"
