---
"cognia-next": minor
---

Drive `/goal` over IM connectors. Telegram / Discord / etc. users can now run `/goal <objective>` (and `status` · `pause` · `resume` · `stop` · `update`) as a connector control command: it reuses the same subcommand grammar as the desktop composer and, because an IM session has no chat hook, spins up a headless driver that pumps the goal loop and posts each turn's reply back to the conversation. The loop honours the pacing gate (quiet-hours / min-interval / manual-hold). Creating an IM goal stays gated behind the per-conversation `allowGoalDriving` opt-in (Inbox → Conversation override); a blocked attempt replies with a bilingual "enable it in the app" hint. Runs wherever the connector runtime runs — the desktop app (all channels) and `cli serve` (webhook channels); the mobile shell has no connector runtime.
