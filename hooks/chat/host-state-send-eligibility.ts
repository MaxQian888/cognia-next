/**
 * Whether a chat turn may be handed to the HostState host as a
 * `message.enqueue` intent instead of being dispatched from this window.
 *
 * The chat controller asks twice:
 *
 *  - BEFORE it builds the send options, with what it already knows, so a turn
 *    that will be handed to the Host is never sealed as a Router + Fusion run
 *    (ADR-0188 B1: host-state sends never stamp; no run would ever be created
 *    for the seal here, and its route would sit remembered for nothing).
 *  - Right before the hand-off, with the final content and options. A turn the
 *    early answer did not foresee as host-state was sealed; it is then NOT
 *    handed to the Host (`routerFusionStamped`) but dispatched here, where its
 *    run is created. A turn foreseen as host-state that turns out not to be
 *    one goes out on the original, unledgered path, legacy cost ceiling
 *    included — it was never sealed.
 *
 * Pure: the controller supplies the facts.
 */

export interface HostStateSendFacts {
  /** Per-turn options and credentials must reach the paired execution host. */
  pairedHost: boolean
  /** The send resolved to a cascade or panel run, which runs in this window. */
  fusionRun: boolean
  /** The send was sealed as a ledgered Router + Fusion direct run. */
  routerFusionStamped: boolean
  /** A re-issued turn (regenerate, loop continuation, steer drain): no new user row. */
  skipAppend: boolean
  /** The provider content is one plain string (no attachment or context blocks). */
  contentIsString: boolean
  /** A context-workbench resource rides the turn. */
  hasResourceContext: boolean
  attachmentCount: number
  /** The turn runs on the session's built-in lane. */
  builtinLane: boolean
  /** The turn was addressed to a lane or member (`@handle`). */
  addressed: boolean
  /** Another runtime's unseen replies ride the turn's content. */
  carriesForeignTurns: boolean
  /** A shared (collaboration) conversation. */
  collaboration: boolean
  /** The standalone engine, which reads the whole transcript itself. */
  standalone: boolean
}

export function hostStateSendEligible(facts: HostStateSendFacts): boolean {
  return (
    // The durable intent contains only the prompt. Rebuilding options on a
    // paired Host drops the caller's provider/model and device-local key;
    // direct Agent RPC already carries those credentials for this turn only.
    !facts.pairedHost &&
    !facts.fusionRun &&
    !facts.routerFusionStamped &&
    !facts.skipAppend &&
    facts.contentIsString &&
    !facts.hasResourceContext &&
    facts.attachmentCount === 0 &&
    facts.builtinLane &&
    // The host runs a queued intent on the SESSION's lane with the session's
    // own character, and writes the intent's `text` as the user row. An
    // addressed turn would lose its `@handle` and its `metadata.turnRoute`
    // there, and a handed-over stretch of another runtime's replies would be
    // recorded as if the user had typed it. Both take the direct path.
    !facts.addressed &&
    !facts.carriesForeignTurns &&
    !facts.collaboration &&
    !facts.standalone
  )
}
