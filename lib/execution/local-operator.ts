/**
 * The identity the local console acts under when it drives run control.
 *
 * `authorized()` in `run-control.ts` asks one question: is this actor the run's
 * INITIATOR, or a configured OPERATOR. Neither is true for the person sitting
 * at this machine, and not by oversight — `initiator` is stamped only by the
 * connector runtime (`lib/connectors/runtime.ts`) for IM-originated work, and
 * `startDirectChatExecutionRun` deliberately omits it, as do the goal, plan,
 * team, workflow and job bridges. `operatorIds` is a per-adapter IM setting.
 *
 * So without this seam every locally-started run — which is all of them on a
 * desktop install — answers `forbidden` to every control command. The gate is
 * doing exactly what it was written to do; what was missing is a caller that
 * can say "this one is mine".
 *
 * The grant is narrow on purpose:
 *  - it names ONE id, minted here and nowhere else;
 *  - it is passed per-command as `operatorIds`, never persisted, so it cannot
 *    widen any other caller's authorization;
 *  - the id is namespaced (`cognia:` + a reserved word) so no platform user id
 *    can collide with it — an IM actor cannot present it, because the remote
 *    paths take their `operatorIds` from adapter settings, not from the actor.
 *
 * A run that a REMOTE user initiated is still controllable from here. That is
 * intended: it executes on this machine, spends this machine's budget, and the
 * person at the keyboard is the one who can physically stop it.
 */

import type { ExecutionRunInitiator } from "@/types/execution/run"

/**
 * Reserved actor id for the local console.
 *
 * Namespaced rather than a bare word: `actorId()` resolves
 * `remoteUserId ?? platformIdentityId`, both of which carry platform-issued
 * ids, and a bare `"local"` could plausibly be one.
 */
export const LOCAL_CONSOLE_ACTOR_ID = "cognia:local-console"

const LOCAL_OPERATOR_IDS: readonly string[] = Object.freeze([LOCAL_CONSOLE_ACTOR_ID])

/**
 * The actor stamped on a control command issued from a local surface.
 *
 * `platformIdentityId` rather than `remoteUserId` because nothing about this
 * actor is remote; `actorId()` reads either, and using the remote field for a
 * local operator would misreport provenance in `control.accepted`.
 */
export function localConsoleActor(displayName?: string): ExecutionRunInitiator {
  return {
    platformIdentityId: LOCAL_CONSOLE_ACTOR_ID,
    ...(displayName ? { displayName } : {}),
  }
}

/** The `operatorIds` grant that makes {@link localConsoleActor} authoritative. */
export function localConsoleOperatorIds(): readonly string[] {
  return LOCAL_OPERATOR_IDS
}
