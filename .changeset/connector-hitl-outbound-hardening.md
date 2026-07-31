---
"cognia-next": patch
---

Three connector reliability hardenings: a tool-approval card can no longer hang a turn forever (a zero/negative approval TTL now falls back to the default auto-deny timeout instead of disabling the watchdog); the outbound send queue now claims each job atomically so two runtimes can never double-send the same message; and every long-lived bot transport (Discord, QQ, DingTalk, Slack, Lark, WeCom, Telegram, OneBot, Matrix) adds jitter to its reconnect backoff so many bots dropped by one network blip don't re-dial in lockstep.
