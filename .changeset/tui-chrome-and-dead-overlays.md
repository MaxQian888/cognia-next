---
"cognia-next": minor
---

CLI: fix five layout defects in the TUI chrome and remove four surfaces that were unreachable.

- The tool-approval prompt now shows the command, the description and the proposed diff **above** the allow / deny list. They used to render underneath it, so Enter could land on "allow" before the change being approved had ever appeared above the cursor.
- `/help` sizes its command column to the longest command instead of a fixed ten characters, so `/transcript` and `/capabilities` no longer collide with their descriptions, and a description long enough to wrap continues under its own column.
- List rows (`/sessions`, `/model`, `/inspect`, every picker) right-align their hints into a second column instead of trailing the label by one space, and the wrap budget now accounts for the panel's border and padding.
- The status footer fits its identity segments first and spends only what is left on the plan chip and the idle hint. The hint used to be reserved up front and truncated the model, context, token and cwd segments to pay for a constant string.
- `stringWidth` measured every character in Miscellaneous Symbols / Dingbats as a two-column emoji, so `✓` and `✗` counted double and any aligned column came out a cell short. Only the code points with `Emoji_Presentation=Yes` are wide now, and `U+FE0F` still forces emoji width.
- The banner's status line uses the same `·` separator as the rest of the app.
- Removed the `files`, `slash` and `config` overlay kinds, the `FileCompleter` component and the `/config` menu rows: none could be reached, having been superseded by the inline mention/slash palettes and by `/settings`.
