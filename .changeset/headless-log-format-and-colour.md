---
"cognia-next": patch
---

Headless server logs are colour-coded again and carry one prefix instead of two. `cognia-server` now stamps each line with a clock and a level-coloured tag (honouring `NO_COLOR` / `FORCE_COLOR`, so `docker logs` can keep its colours), the brain's piped output is reported at the level the child actually claimed rather than flattened to INFO, and the console transport emits terminal ANSI instead of browser-only `%c` CSS — dropping its own clock and icon when a supervisor is already stamping them.

The boot banner (`HTTPS listening on …`, `exec backend: …`, the deny-list and brain notices, the Lark environment report) now goes through that same logger instead of raw `println!`/`eprintln!`, so it is timestamped, level-tagged and coloured like everything else. That moves it from stdout to stderr: `serve` stdout is now empty, and stdout stays reserved for command results — the pair invitation, the service token, and the JSON dumps are unchanged.
