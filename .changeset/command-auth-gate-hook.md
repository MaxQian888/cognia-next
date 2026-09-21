---
"cognia-next": minor
---

Add a `command-auth-gate` built-in hook (opt-in, PreToolUse on `Bash`/`shell_execute_advanced`/`start_process`): a generic credential gate that denies a shell command when a matching rule's `ensure` check fails. Rules come from `.cognia/command-auth.json` and/or `COGNIA_COMMAND_AUTH_RULES` — each `{match, ensure, message?}` entry regex-matches the command line and runs `ensure` as the presence check. Fails open when unconfigured so a fresh install never blocks a turn.
