---
"cognia-next": minor
---

Sending a message now substitutes `{{parameter}}` values into it, and refuses to send while one is still empty. A literal `{{module}}` reaching the model is never what anyone meant — and the model will cheerfully act as though it understood — so the send is declined, the message says how many values are missing, and the editor opens on the first one. Nothing is cleared, so there is nothing to restore.

Substitution runs on the highlighted chips only. Text inside a fenced code block or an inline span is left exactly as typed, so a Jinja, Vue or Handlebars snippet in a prompt is sent verbatim; `{{ }}` inside a slash command's arguments is likewise left for that command's own `$1` / `$ARGUMENTS` expansion.
