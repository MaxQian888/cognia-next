---
"cognia-next": patch
---

Subscription: stop the Claude quota `429 Too Many Requests` storm, and make a reused Codex ChatGPT login actually work

- **Fix "限额查询失败：429 Too Many Requests"**: the unified-limits surfaces (the
  status-bar usage chip, the tray usage feed, and the Subscription
  overview/usage tabs + per-provider quota panels) each fired `refresh()` on
  mount and on every `subscription-changed` event with no coordination, and
  Anthropic's free `/api/oauth/usage` endpoint serves an aggressively
  rate-limited bucket — so those uncoordinated bursts piled up into a 429 that
  rendered as a broken quota panel. Per-account queries now funnel through a
  shared coalescer (`lib/subscription/limits/coalesce.ts`): concurrent callers
  share ONE in-flight request, and real network queries are throttled to at most
  one per account per 60s. An explicit user "Refresh" click passes `force` to
  bypass the throttle (but still coalesces, so a double-click can't double the
  load).
- **Fix "复用 codex-cli 登录无法复用 ChatGPT 订阅"**: adopting an existing codex-cli
  ChatGPT login stamped the credential with `expiresAtMs: 0`, which
  `isCodexCredentialFresh` reads as "never expires" — so the short-lived bearer
  was never refreshed and 401'd on both the chat and external-agent spawn paths
  the moment it aged out, and the account was also misclassified as api-key-only
  (hiding its quota panel). The adopted credential now derives its real expiry
  from the access-token JWT's `exp` claim (falling back to "expired now" so the
  first use refreshes via the long-lived refresh_token), restoring the
  "a ChatGPT login always carries a real expiry" invariant the rest of the Codex
  subscription code already assumed.
