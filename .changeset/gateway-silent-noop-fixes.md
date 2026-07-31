---
"cognia-next": patch
---

Gateway: fix four protections that were configurable but never took effect.
Concurrency caps (`Max concurrent / gateway key` and `/ upstream account`) now
apply to `/v1/embeddings` and `/v1/responses`, not just chat — the cap you set
is one budget shared across every endpoint. Embeddings and failed Responses
calls now report their outcome, so a provider that fails them trains the same
health / circuit-breaker / cost telemetry chat already did (previously it
failed invisibly and never tripped its breaker). The `least-busy` routing
strategy can now see the load the gateway itself is generating, so a burst of
concurrent inbound requests spreads across deployments instead of piling onto
one. And `/v1/models` no longer advertises models on protocols the gateway
cannot execute, which used to 404 on the very next call.

A streamed gateway response now gives up after five minutes of complete
silence from the upstream and reports the stall as a failure. Previously such a
stream was held open forever, pinning its concurrency slots — and with the
routing change above it would also have steered traffic away from that provider
permanently, with nothing in the UI to explain it.

Gateway settings: number fields and tag inputs now commit on blur or Enter
instead of on every keystroke. The port field was effectively unusable — typing
`8080` snapped to `1024` on the first digit — and fields could not be cleared
and retyped. Tag inputs also gained an add button and no longer discard text
that was typed but not confirmed with Enter.
