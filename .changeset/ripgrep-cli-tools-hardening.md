---
"cognia-next": patch
---

Harden the declarative `cliTools` pipeline and the first-party ripgrep plugin: cliTool entries can now declare `access` (read/write classification for the agent's workspace-confinement gates, with credential paths hard-denied) and `confinedPathParams` (path-valued params must resolve inside the workspace or plugin dir before the consent prompt runs); the `cli:execute` consent reason now shows the rendered command line; `cliTools[].timeoutMs` sizes the resilience backstop and the sidecar IPC-relay ceiling instead of being dead configuration; binary detection honors `COGNIA_<NAME>_PATH` overrides. `ripgrep-tools` itself now passes `--no-config`, confines its `path` operand, declares `access: "read"`, uses integer-bounded numeric params, and grows context/type/hidden/no-ignore/multiline/max-filesize flags.
