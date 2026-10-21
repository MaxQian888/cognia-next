# Prompt Audit (vendored)

`prompt-audit.md` is copied unmodified from
[anthropics/skills](https://github.com/anthropics/skills), path
`skills/claude-api/shared/prompt-audit.md`, pinned at commit
`9d630808e4add0a7146de4af9384155d5dee350a` (2026-10-09). It is licensed under
the Apache License, Version 2.0 (`LICENSE.txt` in this directory).

Cognia ships it unchanged as a reference resource of the plugin's playbook
Skill. The plugin's own audit prompt (`src/prompts.ts`) is a condensed
adaptation of its method — the anti-pattern groups, the keep list, the report
fields and the flag-versus-fix threshold — rewritten for Cognia's surfaces and
for targets other than Claude. Pinning keeps the audit rules from changing
when upstream does; update deliberately by replacing the file and the commit
above together.
