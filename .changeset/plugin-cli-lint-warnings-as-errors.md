---
"cognia-next": patch
---

`cognia plugin lint` gains `-W` / `--warnings-as-errors`: it exits non-zero when any warning is present, so CI can keep warning-severity rules from rotting (every warning rule was previously decorative — nothing could gate on one). A third `notice` severity tier is added for advisory rules that never gate, on either axis (no rule emits one yet). The lint `--json` `schemaVersion` bumps to 2: the report can now carry `notice`-severity diagnostics, and its `ok` field can diverge from `valid` under `-W` (`valid` = no errors; `ok` = passed the gate).
