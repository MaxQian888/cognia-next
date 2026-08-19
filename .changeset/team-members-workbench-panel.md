---
"cognia-next": minor
---

Move a team conversation's member list into the right-hand workbench, and let each member open their own chat.

Starting a conversation from a team used to pop a third column between the chat and the workbench: a 224px rail with its own collapse toggle and its own persisted visibility flag, showing an avatar, a name and a status dot. It appeared out of nowhere the moment a team session opened, and it squeezed the chat exactly when a team turn had the most to show.

It is now a **Team members** panel in the Context Workbench, beside every other session-scoped surface (sources, memory, logs, agent status) — it opens, resizes and closes like all of them, and only claims a rail slot inside a team conversation. The mobile members sheet shows the same panel, so there is one roster rather than two.

The panel also says considerably more than the column did. It is headed by the team's avatar, name and **orchestration mode** — which member replies, and why, previously readable only in team settings — and each member now carries its **role in this team**, the **model it will actually answer with** (the member override, falling back to the character's, then the session default), and a **supervisor mark** when the team has a leader. Shared notes keep their collapsible editor and character count.

Each member is now two actions instead of one. Clicking a member **opens their own one-to-one conversation** the way a Slack or Discord member list does — switching to the existing chat with that character, or starting it — while the trailing `@` mentions them in the composer. Both, plus "stop this member", are on the row's context menu.
