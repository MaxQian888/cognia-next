---
"cognia-next": minor
---

Feishu dual-entry surfaces are now operable and on by default.

The identity registry gained the operator loop it was missing: unbound senders
were told to ask an administrator to approve a bind code that nothing in the
product could read. Tenant admission, bind approval, principal disable/relink
and the stale-code sweep are now available from the Lark adapter settings card
and from `cognia-agent lark …` for headless installs. Enabling the registry no
longer parks an existing workspace — it seeds itself from the Feishu identities
that workspace has already conversed with.

Connector card callbacks are authorized by default: a click from someone who is
neither the requester nor a configured operator is refused rather than
executed. The run-operator allowlist those checks read is finally configurable.
Set the callback-authorization mode to `audit` per adapter to restore the
previous shadow behavior during migration.

Also: the `+` menu works (it had no caller), Chat Tabs appear in chats the bot
already belongs to (only a fresh bot-join created one before), turning a
surface off withdraws what it published, the chat-surface retry backoff has a
driver, and inbound rate limits can express a per-tenant ceiling.
