---
"@cognia/agent": minor
---

Expose keyless record and replay through `client.evals`, on the host's existing engine.

`replay()` runs the real agent loop — real build-options assembly, real sidecar, real tools, real
permission gate, real persistence — and substitutes only the model endpoint, so it needs no provider
credential and cannot reach a provider even if something tries. `requireSynthetic` defaults to on, so
a fixture read out of a repository is refused unless every tape is marked synthetic.

`record()` opens the host's recording proxy and returns its URL; stopping it yields the captured
fixture, marked non-synthetic so it cannot be committed until a human has scrubbed it. An abandoned
recording is closed when the handle is disposed or the host shuts down, so a listening socket can
never outlive the client. `refreshFixture()` re-derives digests after an intentional edit.

No new eval engine: this is a surface over `cli/src/eval/replay`.
