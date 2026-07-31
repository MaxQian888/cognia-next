---
"cognia-next": patch
---

Stop a truncated `db.json` from silently wiping the CLI database. The snapshot is
now written atomically (temp + fsync + rename, with one `.bak` generation), and a
corrupt or schema-incompatible snapshot is preserved aside instead of being
overwritten — the CLI reports where it went rather than starting empty in silence.
