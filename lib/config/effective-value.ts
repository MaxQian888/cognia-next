/**
 * One resolved configuration value, plus where it came from.
 *
 * This shape started life inside the IM connector facade as
 * `EffectiveConfigValue<T>`, and it is the right shape for any layered
 * configuration: a Bot installation resolves an executor, an autonomy ceiling
 * and a credential binding through exactly the same question, "what is the
 * value, who supplied it, and was something else refused on the way".
 *
 * Only the source vocabulary differs per domain, so it is a type parameter.
 * A domain declares its own union (`ImConfigSource`, `BotConfigSource`) and
 * aliases this type, which keeps every `source:` literal checked against a
 * closed set instead of widening to `string`.
 */
export interface EffectiveValue<T, S extends string> {
  /**
   * What the layer nearest the user asked for, or `undefined` when nothing
   * was requested. Kept apart from `effective` so a UI can show a request
   * that was overruled rather than silently rendering the winner.
   */
  requested: T | undefined
  /** The value that will actually be used. */
  effective: T
  /** Which layer supplied `effective`. */
  source: S
  /**
   * Present when the requested value was refused rather than merely outranked.
   * Absent means "nothing was blocked", never "blocked for an unknown reason".
   */
  blockedReason?: string
}
