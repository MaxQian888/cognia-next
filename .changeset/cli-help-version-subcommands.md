---
"cognia-next": patch
---

`cognia-agent help` and `cognia-agent version` now print usage / the version to stdout and exit 0, instead of falling through to the unknown-command branch that wrote `unknown command "help"` to stderr and exited 2. The non-zero exit made every such invocation surface as `ELIFECYCLE Command failed with exit code 2` when run through a package script (e.g. `pnpm cli:dev help`). Both subcommands mirror the existing `-h`/`--help` and `-v`/`--version` flags; they are dispatched after the `-p` shorthand, so `cognia-agent -p help` still sends "help" to the agent as a prompt. A bare invocation with no command and a genuinely unknown command keep their exit-2 usage-error contract.
