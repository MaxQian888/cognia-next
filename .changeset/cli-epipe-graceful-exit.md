---
"cognia-next": patch
---

`cognia-agent run … | head -N` no longer crashes with an unhandled `EPIPE` stack dump when the downstream consumer closes the pipe early. The CLI installs a closed-pipe handler on stdout/stderr at process start and exits quietly (SIGPIPE semantics) — sidecar roles keep the default behaviour since their stdout is a protocol wire where a dead consumer should surface as a failure.
