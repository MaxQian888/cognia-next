/**
 * A `role: "user"` message that an automation wrote, not a person.
 *
 * Several producers append user-role rows to a conversation: a finished
 * background task reporting back, the project coordinator nudging a thread, a
 * workflow node, a plugin, a verifier, an external agent runtime, an imported
 * transcript. Without a marker such a row has the exact shape of something the
 * person typed, so every reader that asks "what did the person say last" has
 * to guess.
 *
 * The producer stamps `metadata.automatedTurn` instead. The outbound policy
 * engine (ADR-0239) reads it: an automated row is never the requester's
 * instruction, so it cannot advance the instruction epoch, lift a denial's
 * fence or end an instruction grant. A row a person caused through a surface
 * other than the composer (an approval reason, an island reply, an async
 * question answer, a voice turn) is the person's and stays unmarked.
 *
 * Any object under the key counts, whatever its producer says, so a row from a
 * newer build reads as automated here too.
 */

export const AUTOMATED_TURN_METADATA_KEY = "automatedTurn"

export const AUTOMATED_TURN_PRODUCERS = [
  /** A background task's result delivered into its session. */
  "background-result",
  /** The project coordinator: a PR nudge, routing, a staged thread prompt, a continue seed. */
  "project-coordinator",
  /** A workflow node posting into a conversation. */
  "workflow",
  /** A plugin seeding or sending into a conversation. */
  "plugin",
  /** A verifier agent's request to the agent it checks. */
  "verifier",
  /** User-role input an external agent runtime reported out of band. */
  "external-runtime",
  /** A transcript carried over from another device or app. */
  "history-import",
] as const

export type AutomatedTurnProducer = (typeof AUTOMATED_TURN_PRODUCERS)[number]

export interface AutomatedTurnMarker {
  producer: AutomatedTurnProducer
}

/** The metadata fragment a producer spreads into the row it writes. */
export function automatedTurnMetadata(producer: AutomatedTurnProducer): {
  automatedTurn: AutomatedTurnMarker
} {
  return { automatedTurn: { producer } }
}

/** True when a message's metadata carries an automation marker. */
export function isAutomatedTurnMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false
  const value = (metadata as Record<string, unknown>)[AUTOMATED_TURN_METADATA_KEY]
  return value !== null && typeof value === "object"
}
