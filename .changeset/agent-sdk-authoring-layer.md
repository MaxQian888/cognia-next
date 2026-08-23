---
"@cognia/agent": minor
---

Add the v0.2 authoring layer: host-persisted, immutable, versioned agent definitions.

`client.agents` creates, reads, lists, updates, archives and restores `AgentDefinitionV1` records
that the host stores under its data home — atomic 0600 writes, one immutable file per version, and
compare-and-swap updates that write N+1 or fail with `version_conflict`. A definition may only
_append_ to its preset's instructions, never replace the system policy, and metadata that looks like
a credential is refused rather than stored.

`session/create({ agent })` resolves `latest` exactly once, at creation, and freezes the version,
definition digest and execution fingerprint into the session, which survives a host restart. A
session created from v1 keeps running v1 after the agent reaches v9.

`defineTool()` derives the model-facing JSON Schema, the handler's types, and two-sided runtime
validation from one Valibot schema, with `defineRawTool()` as an `unknown`-typed escape hatch.
Definitions store the tool contract and its schema digest, never handler code, and the host now
refuses to start a turn when a declared tool has no registered handler or the registered handler's
digest has drifted — before any tokens are spent. Structured output is read through
`parseStructuredOutput()`, which distinguishes absent output from invalid output instead of folding
both into a string on a successful result.
