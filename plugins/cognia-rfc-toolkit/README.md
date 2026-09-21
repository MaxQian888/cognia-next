# cognia-rfc-toolkit

Structured technical-design (RFC) skills for Cognia agents. The plugin ships three `local-bundle` skills that work together:

- **`rfc-write-plan`** — plans a bug fix, new feature, or refactor by loading a task-type-specific guide and output template, researching the codebase, and writing a precise design document to a user-specified path.
- **`rfc-reflect`** — critiques a proposal draft along five dimensions (completeness, knowledge sufficiency, knowledge correctness, clarity/feasibility, output format) before it is written out.
- **`mermaid-visualizer`** — produces syntactically valid Mermaid diagrams with clean layout; `rfc-write-plan` defers to it for every diagram block.

Ported from the aiden-plugins `arch` bundle with vendor-specific tooling (internal search tools, generated-code references, org templates) removed. The mechanism is fully generic: it only assumes standard file tools plus `${COGNIA_PLUGIN_ROOT}` for loading its own reference files.

## When to use / not use

- Use when the user asks for a technical proposal, design doc, RFC, or structured implementation plan.
- Do not use for direct code changes (the skills produce documents, not implementations), for repository-specific proposal workflows already provided by project skills, or where a simpler plan-mode answer suffices.

## Platform support

`local-bundle` skills are read through the desktop filesystem bridge, so the plugin is desktop (`tauri`) only; it is marked `blocked` for browser and mobile runtimes.
