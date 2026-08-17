---
"cognia-next": minor
---

Issue tracker: notifications, interactive IM cards, and filing issues from chat.

- The Notification Center gains an **Issues** source: assignments, run outcomes,
  issues arriving at _In review_ / _Done_ / _Canceled_, and comments by others
  now show up there with an "Open issue" action. When an issue was filed from an
  IM conversation (or a conversation is bound to its project) the same event is
  pushed back to that conversation — still gated by the conversation's proactive
  push opt-in and the PII gate.
- Interactive issue cards on Lark, Discord, Telegram, Slack and WeCom: the
  card offers exactly the moves the board would allow (never _In progress_,
  which the runtime owns), a **Run** button when an engine can take the issue,
  and a link back to the board. Text-only channels get a numbered mirror.
- Ask the assistant to file an issue in chat (or reply to a message and ask):
  a confirmation card lists up to five projects — the conversation's last
  choice first — and **nothing is saved until a project is tapped**. The
  assistant also gets `issue_list_projects` to resolve project names.
- Lark and Slack inbound messages now carry the replied-to message id, so
  "quote → issue" works there as it already did on Telegram and Discord.
