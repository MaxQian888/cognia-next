/**
 * IM rate-source contract (plugin⇄IM extensibility — `im-rate-source` capability).
 *
 * The unified subscription `LimitsSource` (`types/subscription/limits.ts`) is a
 * provider-CREDIT shape (`fetch → ProviderLimits` windows/meters) and is the
 * WRONG type for "may this conversation send an AI reply right now". This is the
 * parallel, IM-scoped contract: a pure `matches` predicate + an async
 * `evaluate` that returns a per-conversation send decision.
 *
 * Advisory / additive ONLY: a source can BLOCK (`{allow:false}`) or abstain
 * (`null`) — it can further RESTRICT the built-in connector policy but never
 * relax it (the built-in quiet-hours / mute / rate-limit gates still apply
 * downstream). Consulted by `resolveImRateSources` + `evaluateImRate`
 * (`lib/connectors/im-rate/registry.ts`) at the top of the connector runtime's
 * ai-run branch, before the send is built.
 */
export interface ImRateSource {
  /** Stable match/diagnostic token (e.g. `<pluginId>:<source>`). */
  key: string
  /** Pure predicate — does this source apply to this adapter / platform? */
  matches(q: { adapterId: string; platform: string }): boolean
  /**
   * Decide whether an inbound-triggered AI reply may proceed for this
   * conversation now. `{allow:false, reason}` BLOCKS (the runtime suppresses
   * the turn + audits); `{allow:true}` explicitly permits; `null` abstains
   * (fall through to the next source / the built-in policy).
   */
  evaluate(ctx: {
    adapterId: string
    conversationKey: string
    platform: string
    now: number
  }): Promise<{ allow: boolean; reason?: string } | null>
}
