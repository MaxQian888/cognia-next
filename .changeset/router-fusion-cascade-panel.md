---
"cognia-next": minor
---

Router + Fusion can now run cascade and panel turns. Both are off unless you have switched Router + Fusion on for a surface.

- **Chat.** A new chip in the composer sets each conversation's mode: Auto, Direct, Cascade or Panel.
  - Cascade: a cheap model drafts the answer, the draft is checked, and a strong model takes over if the check fails.
  - Panel: independent models answer, a judge compares their claims against evidence from the web and your workspace, and one verified answer is written.
  - Both are text only and run without agent tools. While one works, a progress card shows its phase and spend, and the answer appears only once it is verified.
  - The answer's run card shows the roles, the phase timeline, the judge's findings and the cost.
  - A chat Cascade that has no schema or test commands to check against is checked by a stronger model's review.
  - Cascade and panel turns appear in Agent Runs, where they can be stopped.
- **Gateway.**
  - `cognia/auto`, `cognia/direct`, `cognia/cascade` and `cognia/panel` are served on `/v1/chat/completions`.
  - The Run API adds session and artifact endpoints.
  - Every gateway error now uses one shape.
  - A key limited to named models can use `cognia/*` only if its list names them, and their answers count against the key's token quota.
- **Settings.** Settings → Routing → Router + Fusion adds:
  - run caps for cascade and panel;
  - approvable Auto rules for cascade and panel;
  - an action editor for the model alias behind each role, how answers are checked, per-action caps, panel size and web evidence, plus actions of your own.
