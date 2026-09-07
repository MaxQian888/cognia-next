---
"cognia-next": minor
---

Subscription quota, balance and token-refresh calls now back off the way the provider asked instead of on a fixed timer, and can fail over to a sibling account.

Every failed call is classified (account quota vs per-minute throttle vs concurrency vs capacity vs revoked credential) and the wait comes from the response itself: `Retry-After`, `retry-after-ms`, `x-ratelimit-reset*`, or a reset window named in the body, including the Simplified Chinese phrasing CN coding plans return. When several windows are named the longest wins, and a server hint longer than our own ceiling is honored rather than clipped, because a two hour reset used to be retried eight times inside its own window. Blocks are held in one credential ledger shared by the status bar, tray, settings tabs and slash command, merge with MAX so one surface cannot shorten another's wait, escalate while a failure persists, and clear on the first success. A 403 account cap, a 402 billing cap and a 5xx outage arm a block now. Previously only a literal 429 did, so everything else was re-polled every five minutes forever. A revoked refresh token latches until the account is re-authenticated instead of being re-exchanged on every quota poll.

Balance readings gain the single-flight, throttle and block treatment the limits path already had, and share the same ledger, so a block earned by either read stops both. The Codex probe now runs through that shared path instead of bypassing it. Both usage-probe loops jitter their cadence so parallel accounts and windows stop firing in lockstep, never below the 60s floor, and a failing probe backs off rather than paying for another request on the next tick.

New, off by default, per provider under Settings, Subscription: switch the active account to another one you have added when the current account's quota window is spent. Only an account-level cap triggers a switch, each account is tried at most once, and blocked or re-auth-needed accounts are skipped.
