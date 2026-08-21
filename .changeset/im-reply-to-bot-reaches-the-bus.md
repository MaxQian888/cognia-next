---
"cognia-next": patch
---

IM connectors: replying to one of the bot's own messages in a group now reaches the bot. The `reply-to-bot` trigger rule was unreachable in group chats — conversation admission dropped every unmentioned group message as `at_mention_required` before the delivered-message ledger had resolved who authored the replied-to message, so the rule (which `defaultGroupChatPolicy()` gates on alongside `self-mention`) could never fire. The parent-author lookup now runs ahead of admission, and both mention gates treat a reply to the bot as a direct address, exactly like an @-mention. Matching stays strict: an unknown or third-party parent author is still not a reply to the bot.
