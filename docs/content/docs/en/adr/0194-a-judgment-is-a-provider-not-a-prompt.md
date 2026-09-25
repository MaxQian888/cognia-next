---
title: "0194 — A judgment is a provider, not a prompt"
description: "System-1 decisions — typed yes/no, pick-one and score questions answered in one pass with calibrated probabilities — become a host capability (`ctx.decisions`) backed by a provider registry. The laya plugin is the local provider, TypeSafe-compatible endpoints the remote one. Every request is redacted and PII-gated regardless of where the provider claims to run, and providers reply with a typed envelope instead of throwing."
---

# ADR 0194 — A judgment is a provider, not a prompt

**Status:** Accepted — implemented
**Date:** 2026-09-25
**Related:** [ADR-0145](./0145-python-plugin-runtime-alignment) (python-backed contributions, the contract catalog), [ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin) (in-tree plugins use the SDK alone), [ADR-0026](./0026-plugin-extension-points-v2) (lazy-factory module bridges)

## Context

Two things arrived at once.

`jev-chat/jev-chat-jarvis` (MIT) is an Android chat copilot whose core loop
never asks a language model "what do you think?". It asks a **System-1
decision model** seven typed questions — is the latest message literal, what
does the other person actually want, how close is this to a fight (0–9), what
do they need, should the next message carry substance, what action fits, is
the tension resolved — and gets calibrated probabilities back in about a
second. An LLM then drafts three replies, and the same decision model ranks
them. The protocol is small: `POST {model, state, questions}` → `{answers}`,
with question types `noul` (yes/no), `choice` (pick one key) and `score`
(ordered levels).

`plugins/cognia-laya-guard` already ran **laya**, a local encoder that speaks
exactly that question format, for inbound IM moderation. Its `laya_decide`
tool was a passthrough nobody in the host could call, and the plugin could not
offer its engine to anything else.

Porting the copilot as one feature that calls one backend would have repeated
the pattern the plugin already showed: a capability locked inside whichever
code happened to need it first.

## Decision

### 1. `ctx.decisions` is a host capability with a provider registry

`lib/decisions/` owns the subsystem:

- `types/decisions` — wire question / answer types, `DecisionProvider`,
  `DecisionResult` (ok with typed answers, or a typed error kind), settings.
- `registry.ts` + `host-registry.ts` — one registry for the built-in remote
  endpoint and plugin contributions, with `subscribe()` and a stable `list()`
  snapshot for `useSyncExternalStore`.
- `run-decision.ts` — **the one entry point.** Validation, provider
  resolution (explicit id, else `settings.decisions.providerId`), a recursion
  guard, redaction, the PII gate, a deadline, and normalization all live here.
  The reply copilot, the settings probe and the plugin API all call it.

Plugins consume through `ctx.decisions.decide()` (`decisions:run`) and
contribute through `manifest.decisionProviders[]` or
`ctx.decisions.registerProvider()` (`decisions:provide`). A python plugin
backs a provider with `@cognia.contribution("<id>")`: the host reads
`describe()` once for the plain descriptor and proxies `decide` / `status`.

### 2. Every request is redacted and gated, whoever the provider is

`runDecision` runs `redactText` over every string **value** in the state and
the question text (keys are untouched, so choice keys survive), then refuses
with `pii` if `hasNoLeakingPiiDeep` still finds anything. This applies to local
providers too. `locality: "local"` is a claim a plugin makes about itself; the
host cannot verify it, so it is display-only.

### 3. Providers reply with an envelope, never an exception

`decide()` returns `{ok: true, answers, latencyMs, routing?, truncation?,
stateTrimmed?}` or `{ok: false, error: {kind, message}}`. A python-backed
provider crosses an RPC where exceptions arrive as bare strings, so a typed
kind has to travel as data. Unknown kinds become `provider_error`; laya's
`not_ready` / `invalid_question` / `predict_failed` map onto the host's
`provider_unavailable` / `invalid_request` / `provider_error`. Only the
request crosses the RPC — the host's `AbortSignal` is not serializable, so
`runDecision` races the call against the signal and a deadline instead.

### 4. Two backends ship: local laya, remote TypeSafe-compatible

- **Local**: the laya plugin contributes `laya-local`. `describe()` advertises
  the routed checkpoint's token budgets (`limits`), which callers use to pick
  compact question wording. `decide` honors `stateTrim` — the path of a list
  whose *oldest* entries may be dropped to fit — because laya otherwise cuts
  the serialized state from the tail, which for a chat drops the newest
  messages. Truncation is reported, never hidden.
- **Remote**: `builtin:decisions-http` posts through `createPlatformFetch`
  (the network-egress gate's managed transport) to OpenRouter
  `api/alpha/decisions` or a `/v1/systemone` gateway (Bocha, TypeSafe, Vercel,
  OpenCode Zen, custom). Plain http is refused except for loopback. The key
  lives in the keyring per preset, never in settings.

`AppSettings.decisions` is `device-local`: the selected provider is often a
plugin that exists on one machine only, and the key is in that machine's
keyring.

### 5. No provider is a labelled state, not a hidden one

Without a provider, a consumer gets `no_provider`. Features that need a judge
render that as an explicit inert state (the reply copilot still drafts, unranked)
rather than quietly skipping the judgment.

### 6. Calibrated is not validated — features gate on measured question sets

`calibrated: true` says a provider's probabilities are honest, not that it is
right about a given task. A provider lists the named question sets it was
measured on and passed in `validatedQuestionSets`; a feature built on a set
uses only providers that list it.

The reply copilot's judge + rank set is `jev-judge/v1`. The built-in endpoint
counts as validated for its Jev presets (the models Jarvis calibrated it on)
and not for a custom URL. Laya was measured with
`plugins/cognia-laya-guard/tools/calibrate_jev.py` on Jarvis's 30-case labeled
set and scored near chance (intent 17–23% on six options, danger MAE 2.2,
against a bar of ≥60% / <1.0), in both the compact and the full wording. It
therefore declares no set: with laya selected the copilot reports
`not_validated`, drafts without ranking, and says so. Laya stays a provider
for everything it does measure well (inbound moderation) and for plugins'
own questions.

### 7. An inbound hook can annotate, not only block

`onConnectorInbound` gains a fourth decision, `{ action: "annotate", labels }`:
keep the message and attach labels (a key, a 0..1 score, an optional
severity / label / note). The dispatcher validates the raw plugin output
(key shape, finite score, redacted notes), caps it (8 per plugin, 16 per
message), stamps the source plugin, and returns the labels alongside allow or
transform; a block still wins. The bus carries them on the event's top-level
`inboundLabels` (not `channelData`, which recovery compaction drops),
`insertInboundMessage` persists them as `metadata.inboundLabels`, an edit
clears them, and the transcript renders them as chips. Outbound ignores
annotate. Laya's observe mode uses it: a would-be block now shows its scores on
the message instead of only bumping a counter.

## Alternatives rejected

- **Emulate the judge with the chat LLM.** Cheap to build, but it yields model
  self-reported confidence, not calibrated probabilities, and it would look
  identical to a real judge in the UI. Rejected in favor of an explicit "no
  provider" state.
- **Let the copilot call laya's tool directly.** Couples a host feature to one
  plugin's tool name and argument shape, and leaves every other consumer
  without a way in.
- **Trust `locality` to skip redaction for local providers.** A plugin can
  declare anything; the gate has to hold without believing it.

## Consequences

- One more capability family in the contract catalog (`decision-provider`,
  `decisionProviders[]`, `ctx.decisions`, two permissions) and its mirrors.
- The laya plugin becomes a general local System-1 backend rather than a
  single-purpose moderation hook.
- Redaction means a judge sees `<PHONE_001>`, not the number. For typed
  judgments about intent and tone that is the right trade; a future question
  that genuinely needs the raw value will have to be answered by a different
  mechanism, not by weakening this gate.
