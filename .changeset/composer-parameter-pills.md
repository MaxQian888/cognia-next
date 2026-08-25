---
"cognia-next": minor
---

The composer now recognises `{{parameter}}` tokens in the message box. Each one paints as a chip over the text — the textarea stays the source of truth, so the token survives a reload for free — and Backspace or Delete beside a chip removes the whole token in one keystroke instead of leaving a broken `{{modu`. A caret placed inside a token still edits it character by character, which demotes it back to ordinary text: the chip is a convenience, never a cage. Tokens inside a fenced code block or an inline span are left alone, so pasting Vue, Handlebars or Jinja into a prompt does not sprout chips.
