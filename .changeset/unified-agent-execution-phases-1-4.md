---
"cognia-next": minor
---

Unified agent execution (ADR-0090) phases 1–4: provider settings gain a
policy-validated custom-headers editor and a derived deployment-profile card;
custom Anthropic-protocol providers can explicitly opt into the experimental
"Claude Agent SDK via built-in Gateway" execution path (flag-gated, policy
only); the LLM gateway adds route tickets, snapshot version authority,
same-protocol header/error parity, and a headless (`cognia-server`) mode with
`profiles` / `gateway` admin subcommands.
