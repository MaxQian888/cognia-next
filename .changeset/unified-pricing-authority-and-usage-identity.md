---
"cognia-next": minor
---

Cost is now decided once, by one pricing authority, and recorded so it cannot
drift afterwards.

The routing engine and the gateway previously priced models through
`@cognia/provider-core`'s own resolver, which omits the built-in static price
tables. The seam built to let the app inject its unified resolver was never
called, so any model known only to those tables priced as "unknown" for
cost-aware routing and the daily cost budget while the Usage tab priced it
correctly. The host resolver is now installed at startup, so routing, the
gateway snapshot, the Usage tab and the CLI all agree.

The context popover no longer prices tokens through the third-party `tokenlens`
table — an entirely separate price list that could disagree with the session
cost badge inches away. It now shares the app's pricing, which additionally
knows cache-tier and CNY-native rates, and shows "—" instead of "$0.00" when a
model's price is genuinely unknown. The `tokenlens` dependency is removed.

Provider usage parsing was maintained as three hand-kept copies, which is why
Anthropic's cache-TTL split and its server-tool counters reached none of them.
There is now one normalizer (with a pinned sidecar mirror), so 5-minute and
1-hour cache writes are captured separately and web-search / code-execution
invocations are recorded instead of discarded.

Usage rows (schema v172) gain the execution identity that lets a cost row be
joined to its trace, per-project attribution, the frozen price provenance, and
indexes for the columns the cost surfaces filter on — those reads were previously
full-table scans. A recorded cost is now returned exactly as it was written and
is never re-derived, so editing a price table no longer rewrites last year's
spend. Historical rows are labelled rather than re-priced: a row the SDK priced
stays authoritative, and a zero-cost row stays explicitly unknown rather than
being invented at today's rates.

Charges that are not per-token are now modelled and billed: server-tool
invocations (web search at $10 per 1,000), OCR pages, TTS characters, and code
execution container-hours with their monthly included allowance.

Pricing gains an offline floor — a bundled catalog of 787 models derived from
LiteLLM (`pnpm pricing:sync`, validated in CI by `pnpm pricing:catalog:check`).
A model missing from the hand-maintained tables and from an unsynced catalog
used to price as unknown, so a fresh offline install reported real spend as
unpriced.

Spans now record their OTel kind and a lifecycle status. A turn abandoned
mid-flight — an aborted request, a provider stream that died — is kept as an
`incomplete` span instead of being silently deleted, so a hung turn no longer
looks identical to one that never started.
