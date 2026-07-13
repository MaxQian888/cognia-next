---
"cognia-next": patch
---

Harden the QQ Official Bot connector. Passive replies now carry a per-message `msg_seq`, so a second reply to the same inbound message is no longer rejected as a duplicate (past the 5-reply cap or the 5 min group / 60 min C2C reply window the send degrades to proactive instead of failing). One transient token or gateway blip no longer permanently kills the adapter — the gateway loop treats it as a reconnect, detects half-open sockets via missing heartbeat ACKs, and resumes with a reset backoff. Sends self-heal after a console-side secret rotation (token cache eviction + one retry on 401/403), failures surface the platform error code and X-Tps-trace-id plus a health reason in the operator UI, inbound image/file attachments now reach the AI loop as segments instead of empty text, and the connection settings gain a real "who am I" probe via `/users/@me`.
