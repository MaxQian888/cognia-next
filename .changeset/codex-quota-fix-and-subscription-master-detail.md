---
"cognia-next": minor
---

Fix Codex quota/usage never loading, and rebuild Settings → Subscription as a master/detail page.

**Codex quota.** The 5h/weekly rate-limit windows never appeared for a ChatGPT
login because of four stacked defects, each of which was invisible because the
limits source swallowed every failure as a bare `catch { return null }` —
rendering "no data" for what was actually a 401 or a 404, with nothing in the
log. All four are fixed against the upstream `openai/codex` contract:

- **Wrong URL.** `/wham/usage` was appended to the account's _chat_ preset base,
  producing `…/backend-api/codex/wham/usage` (404). The path hangs off the
  ChatGPT backend root; a preset base is now normalized to it, and a non-ChatGPT
  relay base is declined outright rather than having its bearer retargeted at
  chatgpt.com.
- **Missing identity headers.** The request sent only `Authorization`, while the
  backend needs the same headers the chat path already sends — above all
  `ChatGPT-Account-Id`, which selects _which_ subscription's quota to report.
- **No token refresh.** The runner proactively refreshed Anthropic bearers but
  not Codex ones, so an aged-out ChatGPT token 401'd forever. Codex now refreshes
  proactively and reactively, exactly like Anthropic.
- **Source never matched.** The match gate rejected on the preset's `templateId`,
  but Codex presets come from the openai-compatible/openrouter catalog families —
  so a real ChatGPT account whose preset came from the catalog never even ran the
  source.

Failures now surface in the panel instead of rendering blank, and an OpenAI
API-key account — which has no usage endpoint upstream at all — says so rather
than leaving an empty gap that reads as a bug.

**Subscription page.** Replaced the two nested tab strips (provider tabs →
Anthropic inner tabs) with the same grouped master/detail shell the Appearance
section uses: a nav on the left, one panel on the right, collapsing into a Sheet
below `md`. Panels are grouped by concern — Usage & limits, Providers, Vault —
and Backup & transfer and Cloud sync are now first-class nav entries instead of
cards buried below the fold of whichever tab happened to be open. Existing
`?subTab=` / `?innerTab=` deep links keep resolving.
