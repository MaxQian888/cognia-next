---
name: ai-sdk
description: >-
  Build or diagnose Cognia features that use Vercel AI SDK APIs such as
  generateText, streamText, embed, tools, ToolLoopAgent, UIMessage, or useChat.
  Use for provider/model integration, structured output, streaming, tool calls,
  embeddings, agents, and AI SDK type or migration errors.
---

# AI SDK in Cognia

Cognia currently pins `ai` and `@ai-sdk/react` in `package.json`. Verify the
installed versions before every change; use `node_modules/ai/docs/` and
`node_modules/ai/src/` as the API source of truth.

## Workflow

1. **Locate the existing execution seam.** Search for a sibling call before
   adding one. Main paths include:
   - provider/model construction in `lib/ai/provider-consumption.ts`
   - standalone browser/mobile chat in `lib/ai/chat/standalone-engine.ts`
   - agent execution in `lib/ai/agent/agent-executor.ts`
   - reusable RAG/provider packages under `packages/`
2. **Verify the exact API locally.** Search installed docs/source for the
   function, option, result type, and installed provider adapter. Read
   `references/common-errors.md` for known AI SDK 6 migrations. If local
   material is insufficient, use current official AI SDK documentation and
   cite it.
3. **Preserve Cognia architecture.** The main app is a Next.js static export:
   do not add `app/api` route handlers or Server Actions. Reuse the existing
   renderer, Tauri/sidecar, or direct-provider path appropriate to the shell.
4. **Reuse provider resolution.** Build models through
   `createProviderSettingsSnapshot`, `resolveFeatureProvider`, and
   `createFeatureProviderModel` rather than hard-coding provider clients,
   Gateway defaults, API keys, or model IDs. Model choices come from Cognia's
   provider settings and discovery catalogs.
5. **Gate outbound data.** Every new LLM, embedding, or cloud-bound payload
   must pass the `@cognia/redact` PII gate. Run the `pii-gate-auditor` after
   adding or rerouting an outbound path.
6. **Test at the seam.** Inject or mock `generateText`/`streamText`, the model,
   clock, and transport. Cover provider failure, abort/cancellation, empty
   output, usage accounting, and the successful path relevant to the feature.
7. **Verify.** Run focused tests, `rtk pnpm typecheck`, `rtk pnpm lint`, and
   `rtk pnpm test:coverage` before completion.

## API-specific guidance

- Prefer the existing `streamText`/`generateText` patterns unless the feature
  genuinely needs a reusable `ToolLoopAgent`.
- For structured output, confirm the installed `Output` API in local docs.
- For a new isolated `useChat` surface, manage input state explicitly and
  confirm the current transport/message-part contract. Cognia's primary chat
  UI uses its own stores and event mappers, so do not replace it with `useChat`
  as a drive-by refactor.
- Keep options minimal and verify defaults in source.

## References

- `references/common-errors.md` — AI SDK 6 renames and UI-message states
- `references/type-safe-agents.md` — `InferAgentUIMessage` patterns
- `references/ai-gateway.md` — only when the requested feature explicitly uses Gateway
- `references/devtools.md` — development-only observability
