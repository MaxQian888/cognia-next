# Cognia next-prompt prediction: implementation audit

Audit date: 2026-10-19 (Asia/Shanghai). Checkout: `1b4b0a42bb` plus unrelated concurrent changes. No production code was changed. Companion, fleet, and tunnel edits present at the start were outside this audit.

## Conclusion

Cognia has a substantial, wired draft-continuation implementation and a separate follow-up suggestion implementation. The overall feature is not complete as a desktop next-prompt prediction experience. The most consequential gaps are session isolation, draft-first acceptance, subscription/backend eligibility, turn caching, and consumption of the native Claude prediction event. Improving the existing implementation is preferable to adding another generator.

The official product comparison and pinned upstream history are in [the companion research note](./2026-10-19-next-prompt-prediction-product-comparison.md). Competitor behavior below means documented behavior, not a reverse-engineered proprietary implementation.

## What currently works

| Layer                  | Existing implementation                                                                                                                   | Evidence                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GUI draft continuation | Local history and slash-command providers; optional automatic model and manual Agent providers                                            | `hooks/chat/use-composer-ghost-text.ts:143`, `components/chat/composer.tsx:1439`                                             |
| Shared orchestration   | Debounce, abort, stale-result filtering, TTL caches, candidate ranking/cycling/pinning, streaming partials, watchdog timeout, retry       | `lib/chat/completion/inline/engine.ts`                                                                                       |
| Model preparation      | Input/context PII gate; language/intent instructions; echo/fence/newline cleanup; 160-character suffix limit                              | `lib/chat/completion/inline/ai-provider.ts:166`, `lib/chat/completion/ghost-prompt.ts`                                       |
| GUI interaction        | Floating suggestion card, source/status badges, accept/dismiss/cycle/retry, touch buttons; Tab acceptance writes draft without submitting | `components/chat/composer/composer-ghost-card.tsx`, `components/chat/composer.tsx:2408`                                      |
| Follow-ups             | Three short suggested messages after idle assistant-last state; direct utility model, optional Agent fallback; rendered above composer    | `hooks/chat/use-follow-up-suggestions.ts`, `components/chat/follow-up-suggestions.tsx`, `components/chat/chat-view.tsx:1153` |
| TUI                    | Shared engine and local/model/manual providers, keyboard acceptance and cycling                                                           | `cli/src/tui/input/inline-suggest.ts`, `cli/src/tui/components/Input.tsx:490`                                                |
| Settings               | Separate local/model toggles, debounce, follow-ups/starters, Agent fallback, shared model override; translated labels                     | `components/settings/chat/composer-assistance-card.tsx`                                                                      |

Local completions default on; automatic model draft completion defaults off. Follow-ups default on, but Agent fallback defaults off. These are different policies for different features.

## Confirmed defects and contract gaps

### P1: prediction context is not bound to the pane's session

`recentMessages()` in both GUI hooks reads `useChatStore.getState().messages`. Follow-up status and turn identity also select the top-level `status` and `messages`. Those fields mirror the active session, whereas the hooks receive a specific `session` and the split pane is explicitly bound to its own `boundId`.

Consequences: session B can generate a prediction using session A's conversation, with B's resolved model/provider; B's suggestions can disappear or regenerate because A starts/finishes streaming. This is a context-isolation defect and can route one conversation's text through another conversation's configured provider. It does not imply the existing PII gate is absent.

Evidence: `hooks/chat/use-composer-ghost-text.ts:68`, `hooks/chat/use-follow-up-suggestions.ts:35`, `:53`, `:55`; session-scoped selectors already exist at `stores/chat/chat-store.ts:1682` and `:1706`; branch-aware visible-message projection exists at `:1694`.

**Reproduced:** two temporary RTL hook probes supplied active session A, session slices A/B, and hook session B. Both expected B's context. The draft prompt contained `session A context`; follow-up generation received A's message. Both assertions failed for the intended reason. No network/model calls were used.

**Fix direction:** use the bound session and selected visible branch for context, status, turn key, and result ownership. Validate ownership again before displaying or accepting a late result.

### P1: follow-up acceptance immediately submits through an active-session callback

`FollowUpSuggestions` calls `onUseSample(suggestion)` on click. `ChatPaneGroup` forwards the same unbound callback to both panes, while ordinary sends are correctly wrapped with `sessionId`. The desktop callback reaches `handleFirstTurn`, which reads `useChatStore.getState().activeSessionId` at invocation.

This allows a chip shown beside B to send to globally active A. The component also offers no draft review step and has no draft/attachment eligibility input, so chips remain eligible while the user is preparing another message. The cross-session send path is established by source tracing; it was not exercised against a live desktop session.

Evidence: `components/chat/follow-up-suggestions.tsx:40`, `components/chat/chat-pane-group.tsx:184`, `components/desktop/desktop-chat-workspace.tsx:568`, `:635`.

Both [Codex](https://learn.chatgpt.com/docs/features/composer-predictions) and [Claude Desktop](https://code.claude.com/docs/en/desktop#accept-a-suggested-prompt) document accepting prediction text into an editable draft before sending. Claude Desktop explicitly suppresses it while text or attachments are present.

**Fix direction:** stage the selected next prompt into the owning composer's draft; submit through its normal session-bound send only after explicit send. Expose one primary prediction in the empty composer; additional alternatives may remain optional. Use the existing composer intent/handle infrastructure rather than another global send path.

### P2: follow-up turn caching is described but not implemented

The hook's header promises results cached by turn signature. Implementation stores current suggestions and one dismissed key, but no result cache or cross-mount request deduplication. Remounting the same conversation turn starts another chargeable generation. Multiple mounted panes can independently query the same active turn. Turning the feature off/on can also re-fetch it.

Evidence: `hooks/chat/use-follow-up-suggestions.ts:62` through `:132`.

**Reproduced:** mount, await one result, unmount, mount again with identical session/turn. Expected one generator invocation; received two. Ordinary rerenders are avoided by effect dependencies, which is useful but is not a turn cache.

The inline engine does cache, but by draft alone for 30 seconds (`engine.ts:802`). Conversation/branch/model changes are not part of that key. Its cache policy should be strengthened when the prediction context changes, rather than copied as-is to follow-ups.

**Fix direction:** shared bounded cache and in-flight deduplication keyed by session, terminal turn/revision, selected branch, backend/model, and relevant settings; persist dismissal for that turn and invalidate on rewind/regenerate/compaction. Do not cache failures as successful empty predictions.

### P2: enabled does not mean an eligible backend is available

`buildRendererLlmClient` returns null without a renderer-resolvable key/protocol/model. With subscription-only credentials and no separate utility key, follow-ups produce an empty list unless `suggestions.agentFallback` is enabled. Draft completion can use a manual Agent request, but only when model completion is enabled and headless transport was reachable at hook initialization. The UI lacks a structured reason for no backend, policy abstention, or no useful suggestion.

Evidence: `lib/ai/renderer-llm-client.ts:121`, `:124`, `:148`; `hooks/chat/use-follow-up-suggestions.ts:85`; `hooks/chat/use-composer-ghost-text.ts:147`, `:170`, `:244`.

**Fix direction:** report capability/eligibility separately from the user preference. Offer a configured utility backend or explicit native prediction support. Preserve billing consent; silently enabling one full headless turn after every response is not a suitable remedy.

### P2: native Claude predictions are transported but not used as composer predictions

Installed `@anthropic-ai/claude-agent-sdk` is **0.3.302**. Its local `sdk.d.ts:5744` documents `SDKPromptSuggestionMessage`; `promptSuggestions` is supported. Cognia's serializable SDK options expose `promptSuggestions`, and sidecar canonicalization produces `kind: "prompt-suggestion"`.

The GUI adapter explicitly treats `prompt_suggestion` as rendering no transcript row, and there is no composer/store consumer for the native suggestion. The TUI event mapper formats it as a generic interactive event, without feeding it into the prediction engine. Therefore transport/type support does not deliver the feature.

Evidence: `packages/agent-config-types/src/claude-agent-sdk-options.ts:184`; `sidecar/src/runtimes/claude-agent-sdk/sdk-options.ts:623`; `sidecar/src/host/events/canonical/index.ts:147`; `lib/claude/adapter.ts:444`; `cli/src/tui/state/event-mapper.ts:165`, `:236`.

**Fix direction:** opt into native predictions according to capability/settings, route the event into session/turn-owned prediction state, and prefer it over a redundant synthetic follow-up call. Handle suggestions arriving after the ordinary result, missing suggestions, resumed/compacted sessions, and duplicate events. Do not enable two chargeable generators for the same turn. Public [SDK documentation](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpromptsuggestionmessage) confirms the contract. The Codex desktop feature does not by itself establish a stable integration API for external clients.

### P2: TUI shares the engine but not the full GUI behavior

TUI `buildContext` omits `recentMessages`, so model draft continuation sees the draft but not the conversation. It supplies only `complete`, so engine streaming support is unused. The hook result omits `querying`, `streaming`, `completionError`, and `retry`. `createTuiAgentComplete` catches failures and returns null, hiding a failed call as abstention. `Input` does not pass a session id to `useInlineSuggest`.

The TUI Agent call has a 30-second internal ceiling, but the shared engine applies a 6-second no-output watchdog first. Since the TUI adapter emits no partials, a slow healthy Agent can be aborted before that 30-second ceiling. GUI Agent startup is also subject to the 6-second initial watchdog. These deadlines are established by code; actual provider latency was not measured.

Evidence: `cli/src/tui/input/inline-suggest.ts:162`, `:177`, `:219`; `cli/src/tui/input/ai-complete.ts:54`, `:180`; `cli/src/tui/components/Input.tsx:490`; `lib/chat/completion/inline/engine.ts:64`.

**Fix direction:** pass a session-scoped bounded transcript, preserve completion errors, optionally stream, and budget initial Agent latency separately from inter-token silence.

## Improvements that need product/evaluation work

- **Useful context:** current synthetic follow-ups use only the last six plain-text messages, clipping each to its first 800 characters. Tool outcomes and the end of a long final reply can be missing. Draft continuation uses six messages capped at 500 characters. Reuse a bounded, privacy-gated projection of the selected thread with the final result intact. Native prediction may already reuse richer session context. Do not add new file/app/memory retrieval by default.
- **Cost and abstention:** add per-turn budgets, typed eligibility reasons and optional backoff after repeated ignored predictions. Claude CLI documents cache/cost/error/plan/limit gates; decide which are appropriate to Cognia rather than copying every vendor restriction. Codex's free prediction entitlement cannot be assumed for Cognia's own model calls.
- **Failure semantics:** follow-up generation turns errors into `[]` and has no watchdog/retry result state. The model provider retries every thrown error once, despite a comment describing transient-only retry. Classify transport/rate-limit/auth failures and keep ordinary abstention quiet.
- **IME and input ownership:** draft feeding and ghost keyboard branches lack the explicit composition guards used by the adjacent shell-completion path; the card visibility also lacks an IME gate. Treat this as a targeted regression-test/UI-verification need, not a reproduced IME failure. Also test selection ranges, blur, parameter/slash popups, touch/manual invocation and accessibility.
- **Prediction quality:** existing tests validate mechanics, not intent quality. Add a small representative evaluation set for Chinese, mixed scripts, short follow-ups, completed intents, refusal/abstention, tool outcomes, compaction/rewind and long replies. Measure acceptance/edit/dismissal, latency and cost per accepted prediction without logging sensitive raw drafts.

## Suggested order and acceptance checks

1. **Session isolation and draft-first acceptance.** A/B split-pane probes must pass; accepting B's prediction must affect only B's draft and must not invoke any send. Existing text/attachments suppress empty-composer prediction.
2. **A single per-turn prediction lifecycle.** Cache/deduplicate; invalidate on session/branch/context/backend changes; preserve dismissal; discard late results. Verify remount does not re-bill.
3. **Backend eligibility and native Claude event consumption.** Verify subscription-only, BYOK, external runtimes and pure web/companion separately. A native suggestion and a synthetic fallback must not both bill for the same turn.
4. **TUI parity, quality and cost policy.** Exercise real acceptance, cancellation, slow startup, error retry and multilingual flows, then measure quality/cost against fixtures.

## Verification performed and limits

Existing checks run:

```text
rtk pnpm exec jest --runInBand --runTestsByPath
  lib/chat/completion/{ghost-prompt,suggestions}.test.ts
  lib/chat/completion/inline/{engine,ai-provider,history-provider,command-provider,rank}.test.ts
  hooks/chat/{use-composer-ghost-text,use-follow-up-suggestions}.test.ts
  components/chat/composer/{composer-ghost-card,composer-ghost-text}.test.tsx
  components/chat/follow-up-suggestions.test.tsx
  components/settings/chat/composer-assistance-card.test.tsx
  cli/src/tui/input/{inline-suggest,ai-complete}.test.ts

Test Suites: 15 passed, 15 total
Tests:       282 passed, 282 total
```

Temporary hook probes used production hooks with mocked stores/generators and correct-behavior assertions:

```text
FAIL: draft prediction for session B must use B conversation
  Expected: session B context
  Received: session A context in outgoing completion prompt
FAIL: follow-ups for session B must use B conversation
  Expected recentMessages: session B context
  Received recentMessages: session A context
FAIL: revisiting the same turn must reuse its result
  Expected generator calls: 1
  Received generator calls: 2
```

The temporary test file was removed after execution; production code and existing tests were unchanged. Existing runs emitted unrelated Haste package-collision warnings from `.tmp/` build copies, and the TUI hook suite emitted an `act(...)` warning; all 282 baseline assertions still passed. Coverage was not collected.

No dev server was listening on port 3000 during the audit. No live Cognia desktop/browser flow, real-provider generation, competitor desktop, latency, cost, or prediction-quality measurement was performed. Thus findings are source-traced or hook-reproduced as labeled, not claims of full E2E verification. No dedicated next-prompt/ghost-text browser E2E was identified in the targeted test search.

## Sources

- [Official product comparison and pinned Claude changelog](./2026-10-19-next-prompt-prediction-product-comparison.md)
- [Codex Composer Predictions](https://learn.chatgpt.com/docs/features/composer-predictions)
- [Claude Desktop prompt suggestions](https://code.claude.com/docs/en/desktop#accept-a-suggested-prompt)
- [Claude CLI generation and suppression policy](https://code.claude.com/docs/en/interactive-mode#prompt-suggestions)
- [Claude SDK prompt suggestion event](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpromptsuggestionmessage)
