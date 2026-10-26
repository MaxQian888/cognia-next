---
"cognia-next": patch
---

A plugin's Lark reply to a group message the bot is not allowed to read (missing `im:message.group_msg`) is no longer refused when a person is connected to the bot: the host looks the message up as that person.
