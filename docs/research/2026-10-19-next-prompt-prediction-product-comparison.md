# Next-prompt prediction: official product comparison

Research date: 2026-10-19 (Asia/Shanghai). This note compares documented product behavior, not reverse-engineered desktop internals. Cognia implementation findings belong in the accompanying audit.

## Scope and evidence

Three different features must stay separate:

- **Next-prompt prediction:** after an assistant finishes, predict the user's next message while the composer is empty.
- **Draft continuation:** complete text the user has already started typing.
- **Command/path completion:** complete a slash command, file mention, or shell-history entry without predicting the user's next conversational intent.

The public documentation establishes the first for both desktop products. It does not establish that either desktop product offers arbitrary natural-language draft continuation while the user types. Absence from these pages is not proof that no private experiment exists.

Sources were fetched on the research date. OpenAI's old Codex documentation paths now redirect to ChatGPT Learn. Claude's documentation is rolling; its desktop's bundled Claude Code version can differ from the standalone CLI. No competitor desktop was manually exercised in this research.

## Documented behavior

| Dimension       | Codex desktop                                                     | Claude Code desktop                                                                  |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Trigger         | After the response; next-message suggestion in composer           | After the reply; gray next prompt in empty composer with no attachments              |
| Acceptance      | Tab creates an editable draft; send separately                    | Tab or Right arrow creates an editable draft; Enter then sends                       |
| Existing draft  | User can keep typing without waiting                              | Typing dismisses the suggestion                                                      |
| Control         | Settings → General → Composer → Show predictions                  | Settings → Claude Code → Sessions → Prompt suggestions; applies on next start/resume |
| Generation cost | Prediction itself consumes neither Codex usage limits nor credits | Short background request consumes plan usage/API cost                                |

Sources: [OpenAI Composer Predictions](https://learn.chatgpt.com/docs/features/composer-predictions), [Claude Desktop: Accept a suggested prompt](https://code.claude.com/docs/en/desktop#accept-a-suggested-prompt).

Codex explicitly bounds prediction context to the current thread. Existing memory or connected-app content already present there can inform it, but predictions perform no new memory/app retrieval. The documented beta is for personal Pro users aged 18+, supported regions, local/SSH threads, and GPT-6 Astra/GPT-6.1 Sol, enabled by default for eligible users. This availability is a product gate, not a requirement Cognia should reproduce. [OpenAI Composer Predictions](https://learn.chatgpt.com/docs/features/composer-predictions)

The launch entry is dated **2026-10-09**. The latest CLI entry observed is **0.163.0, 2026-10-15**; this is not a desktop version. The changelog also lists experimental prediction protocol/fork work, including inherited-context fixes. These entries do not establish a stable, generally supported integration API or CLI composer parity. The current App Server reference contains no `predict` match. [OpenAI changelog](https://learn.chatgpt.com/docs/changelog), [App Server reference](https://learn.chatgpt.com/docs/app-server)

Claude Desktop explicitly states that inline code completion is unavailable and distinguishes it from next-prompt suggestions. Its `/status` reports the bundled Claude Code version; updating the standalone CLI does not update that copy. [Claude Desktop comparison and version guidance](https://code.claude.com/docs/en/desktop#what%E2%80%99s-not-available-in-desktop)

## Claude Code's generation and suppression policy

The CLI uses the session's own model for a short background request that reuses its prompt cache. It may skip cold caches, very short conversations, errors, plan mode, near/exhausted limits, and teammate sessions. Feature-flag availability also affects the default. Repeatedly ignored predictions reduce frequency. Controls include `promptSuggestionEnabled`, `/config`, and `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`; the environment setting takes precedence. These details are documented for the CLI and should not all be assumed to have identical desktop rollout behavior. [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode#prompt-suggestions)

Shell-mode history completion and live path completion are separate mechanisms, not evidence of predictive conversation completion. [Claude shell mode](https://code.claude.com/docs/en/interactive-mode#shell-mode-with-prefix)

## Native Claude SDK opportunity

The current official TypeScript reference documents:

```ts
// query({ prompt, options: { promptSuggestions: true } })
// Default: false
type SDKPromptSuggestionMessage = {
  type: "prompt_suggestion"
  suggestion: string
  uuid: UUID
  session_id: string
}
```

An event appears only for turns that generated a suggestion. The documentation does not promise one after every turn. The reference was fetched as Markdown because the HTML exceeded the web fetch size limit; Context7 independently returned the same option/event documentation. [TypeScript SDK options](https://code.claude.com/docs/en/agent-sdk/typescript#options), [SDKPromptSuggestionMessage](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpromptsuggestionmessage)

The CLI equivalent is `--prompt-suggestions`, requiring `--print --output-format stream-json --verbose`; it emits a `prompt_suggestion` message. [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags)

**Integration proposal, not a verified Cognia capability:** version-gate native SDK prediction, normalize the event into Cognia's existing prediction model, and prefer it over a second synthetic request for that same turn. Preserve an explicitly authorized fallback for unsupported backends. Validate event ordering after the result, cancellation, resumed sessions, compaction, late arrivals, and de-duplication. Do not enable a second chargeable generator alongside Cognia's existing generator without arbitration.

## Recent upstream fixes worth turning into Cognia regression cases

Claude's changelog was pinned to [`ef7bfdca55d906929fe6b782025b93758c325074`](https://github.com/anthropics/claude-code/blob/ef7bfdca55d906929fe6b782025b93758c325074/CHANGELOG.md), commit timestamp **2026-10-18T22:26:35Z**, whose first version heading is **2.1.303**. Relevant entries:

- **2.1.302:** skip prediction after replies billed to usage credits.
- **2.1.283:** reduce terminal prediction frequency after 20 consecutive ignored suggestions.
- **2.1.269:** retain Chinese/Japanese/Thai suggestions and mixed-script/single-word content while filtering meta/evaluative text.
- **2.1.268:** fix SDK prediction using pre-compaction conversation.
- **2.1.257:** repair prompt-cache misses with advisor models.
- **2.1.136:** require acceptance before Enter can send; **2.0.70** had previously introduced direct Enter submission. Therefore historical descriptions of Enter behavior are stale.

This is first-party change history, not public implementation source. It supports regression priorities, not claims about proprietary ranking algorithms.

## Suggested audit dimensions for Cognia

These are recommendations inferred from the documented contracts; the implementation audit must establish which gaps actually exist:

1. Offer one unobtrusive primary empty-composer prediction with keyboard acceptance, keeping editable-draft creation separate from submission. Keep additional suggestions optional rather than equating three chips with desktop parity.
2. Separate the enabled/settings/billing controls for next-prompt prediction and draft continuation; expose why an otherwise enabled feature has no eligible backend.
3. Include the final assistant result and relevant tool outcomes in prediction context, bounded by tokens and privacy policy. Avoid replacing useful completion context with the user's earlier draft alone.
4. Recompute against the current turn/branch/context revision after compaction, rewind, session changes, and model changes; discard stale results before display or acceptance.
5. Add cost-aware eligibility, an optional ignored-suggestion backoff, and meaningful suppression reasons without creating user-visible error noise for normal abstention.
6. Evaluate Chinese, mixed-language prompts, no-space languages, useful short predictions, abstention, intent correctness, acceptance/edit rate, latency, and per-accepted-prediction cost. These need a representative fixture/evaluation set; passing rendering tests alone does not establish prediction quality.

## Sources

- [OpenAI Composer Predictions](https://learn.chatgpt.com/docs/features/composer-predictions)
- [OpenAI changelog](https://learn.chatgpt.com/docs/changelog)
- [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)
- [Claude Desktop](https://code.claude.com/docs/en/desktop#accept-a-suggested-prompt)
- [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode#prompt-suggestions)
- [Claude TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpromptsuggestionmessage)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags)
- [Pinned Claude Code changelog](https://github.com/anthropics/claude-code/blob/ef7bfdca55d906929fe6b782025b93758c325074/CHANGELOG.md)
