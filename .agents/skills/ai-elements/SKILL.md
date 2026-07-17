---
name: ai-elements
description: >-
  Build or modify Cognia AI chat UI with the vendored AI Elements primitives.
  Use for conversations, messages, prompt inputs, reasoning, tool displays,
  attachments, citations, audio, terminal output, or any component under
  components/ai-elements; also use when integrating AI SDK UIMessage parts.
---

# AI Elements in Cognia

Cognia vendors AI Elements source under `components/ai-elements/` and composes
it from first-party chat surfaces. Treat the local source and its consumers as
the contract; upstream documentation is reference, not an overwrite target.

## Workflow

1. **Find the existing primitive and consumers.** Inspect
   `components/ai-elements/<name>.tsx`, its matching file under `references/`,
   and every import in `components/chat/` or the target feature. Confirm the
   AI SDK `UIMessage` part shape in the installed `ai` package before changing
   tool or message rendering.
2. **Choose the ownership boundary.** Put product behavior, translations, and
   state orchestration in a first-party wrapper under `components/<feature>/`.
   Edit the vendored primitive only when the reusable primitive itself is
   wrong or lacks a necessary extension point.
3. **Reuse Cognia integration seams.** Markdown and reasoning use
   `components/ai-elements/streamdown-plugins.ts`; tool states flow through the
   chat message-part renderers; styling uses semantic tokens and `cn()`.
   Preserve static-export compatibility and client boundaries.
4. **Wire user-facing text.** New labels, aria text, placeholders, and errors
   use `next-intl` keys in both English and Chinese catalogs. Even vendored
   component edits must follow this product rule.
5. **Test the owned behavior.** Do not add tests inside
   `components/ai-elements/`; that directory is coverage-excluded. Test the
   first-party wrapper or renderer that exercises the changed behavior.
6. **Verify.** Run the changed Jest tests, `rtk pnpm typecheck`,
   `rtk pnpm lint`, and `rtk pnpm lint:i18n`.

## Adding or updating upstream components

The repository already contains the supported AI Elements subset. Check the
directory before invoking a CLI. For an explicitly requested missing upstream
component, inspect the current CLI with
`rtk pnpm dlx ai-elements@latest --help`, preview affected files, and preserve
local Cognia changes. Never bulk-overwrite `components/ai-elements/`.

## Component reference routing

Load only the reference that matches the requested component. Common entries:

- `references/message.md`, `conversation.md`, `prompt-input.md`
- `references/tool.md`, `reasoning.md`, `chain-of-thought.md`
- `references/attachments.md`, `inline-citation.md`, `sources.md`
- `references/code-block.md`, `terminal.md`, `stack-trace.md`
- `references/audio-player.md`, `speech-input.md`, `transcription.md`

Use the full `references/` directory listing when the component name is not
known. Do not load every reference into one run.
