---
name: streamdown
description: >-
  Implement, configure, style, secure, or diagnose Streamdown in Cognia. Use
  for streaming Markdown, syntax highlighting, Mermaid, math, CJK, carets,
  link safety, custom renderers, or Streamdown integration in AI chat and skill
  surfaces.
---

# Streamdown in Cognia

Streamdown and all four plugins are already installed. The shared integration
is `components/ai-elements/streamdown-plugins.ts`; assistant messages and
reasoning render it through `components/ai-elements/message.tsx` and
`reasoning.tsx`.

## Workflow

1. **Inspect the local consumer and installed API.** Read the target component,
   `streamdown-plugins.ts`, and the installed package types/source. Do not copy
   a generic `useChat` example into Cognia's store-driven chat pipeline.
2. **Reuse the shared plugins.** Code highlighting uses
   `CHAT_CODE_THEME`; CJK, math, and Mermaid share one plugin object so
   streaming and finalized renderers do not visibly change theme.
3. **Keep configuration at the owner.** Shared rendering changes belong in the
   plugin module or AI Elements wrapper; surface-specific controls and security
   policy belong in the first-party consumer.
4. **Protect untrusted Markdown.** Preserve URL transformation, link safety,
   HTML filtering, and Mermaid/security limits. Read `references/security.md`
   before relaxing any default.
5. **Preserve static export.** Avoid Node-only Shiki or Mermaid code in a client
   path unless the existing Next.js aliases/transpilation already cover it.
6. **Test observable behavior.** First-party wrappers require co-located tests;
   `components/ai-elements/` itself is coverage-excluded. Cover streaming state,
   malformed Markdown, plugin failure, and relevant accessibility behavior.
7. **Verify.** Run focused Jest tests, `rtk pnpm typecheck`, `rtk pnpm lint`,
   and `rtk pnpm build` for bundling changes.

## Common branches

- API and prop types: `references/api.md`
- Code/Mermaid/math/CJK options: `references/plugins.md`
- CSS variables and custom components: `references/styling.md`
- URL/HTML hardening: `references/security.md`
- Carets, static mode, controls, and troubleshooting: `references/features.md`

Use examples in `assets/examples/` only after reconciling them with the
installed Streamdown and AI SDK versions; they are not Cognia architecture
templates.
