# DeepSeek Harness wire-trace fixtures

Recorded `session.event` / `session.status` notification streams, one JSON frame
per line, in wire order. These drive the codec tests in
`lib/ai/agent/external/dsh-session-event-codec.test.ts`.

| File                                            | Provenance                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream-bash-tool.notifications.jsonl`        | Upstream regression snapshot, `deepseek-ai/deepseek-harness@master`, `examples/jsonrpc-agent/tests/snapshots/bash-tool/notifications.expected.jsonl`. MIT. Session ids and prompt/tool text are templated upstream (`{{sessionId}}`). |
| `upstream-persistent-tools.notifications.jsonl` | Same origin, `snapshots/persistent-tools/`. MIT.                                                                                                                                                                                      |
| `cognia-sdk-readonly.notifications.jsonl`       | **Cognia-captured.** Live run of `runtime/deepseek-harness/host.sdk-readonly.yml` against `deepseek-v4-flash`, driven by `@deepseek-ai/dsh-sdk-client@0.1.0-rc.6`.                                                                    |

The two kinds are not interchangeable and both are needed.

The upstream snapshots prove the codec handles **DSH's own reference
composition** — including tool families Cognia's read-only profile does not
compose, such as persistent bash. They are upstream's regression baseline, so
they also fail loudly if a channel upgrade changes the event vocabulary.

The Cognia capture proves the codec handles **the composition Cognia actually
ships**. It records the model being asked to write a file under
`cognia-sdk-readonly` and being refused: the write is denied
(`[sandbox: file access denied under read-only mode]`), the model then retries
with `sandbox_permissions: "workspace-write"`, and that escalation fails closed
because the profile composes no approval provider. That sequence is the
evidence behind the read-only guarantee documented in
`runtime/deepseek-harness/host.sdk-readonly.yml`; if a future composition change
silently added an approval provider, this trace is what would stop looking the
same.

## Re-capturing

The Cognia trace needs a real `DEEPSEEK_API_KEY` and network access, so it is
committed rather than regenerated in CI. Re-capture it only when the channel's
pinned upstream version changes, and diff the event-type histogram before and
after — a new required event type is a version-drift signal, not a fixture to
refresh silently.

No API key is required to _run_ the tests; they replay these files.
