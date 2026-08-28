---
"cognia-next": minor
---

Let a run choose the API dialect its endpoint speaks: `cognia-agent run --protocol <openai|anthropic|google|…>` and the matching `COGNIA_PROTOCOL` environment variable, both bound onto the active provider. `providers.<id>.protocol` already existed in config.json and already reached the sidecar as `apiProtocol`, but nothing outside the config file could set it — so the generic per-run overrides could redirect an endpoint's address (`COGNIA_BASE_URL`) and its credential (`COGNIA_API_KEY`) while the dialect stayed pinned to whatever the provider id defaults to. Pointing the CLI at an Anthropic-format gateway therefore meant hand-editing config.json, or picking a provider id that happened to already speak Anthropic. An unrecognized value is rejected with the list of accepted protocols rather than dropped, because a silently ignored dialect sends the turn in the wrong shape and surfaces only as an empty reply.
