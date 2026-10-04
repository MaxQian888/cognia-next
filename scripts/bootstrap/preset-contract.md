# Native preset contract

`presets.json` is the development-time catalog. Both standalone scripts embed the
same JSON; they must run when copied without this file. Cognia expands presets
into the existing v1 configuration. No preset metadata is persisted in v1 files.

## CLI

- `presets [--json]` lists the catalog without credentials or network access.
- `--provider ID`, `--preset ID`, `--recipe ID`, repeatable `--preset-file FILE`
  work with configure/run/chat/init/doctor/models. These modes may start from
  defaults when a preset selector is supplied (doctor/models also may use defaults).
- Precedence: defaults, config, provider, task preset, recipe, custom files in
  argument order, environment overrides, explicit CLI, `--set` in argument order.
  `--task` counts as explicit CLI. Unknown IDs, non-object patches, and unknown v1
  keys are errors. Objects deep merge; arrays and null replace. Provider selection
  REPLACES the entire model object with model defaults plus its catalog model.
  This clears old auth/header/endpoint/model-specific options.
- A recipe uses its `config` plus `powershell` patch when the resolved execution
  shell is PowerShell. Explicit CLI/custom shell settings take precedence; native
  PowerShell is the PowerShell script default, Bash is the Bash script default.
- Applying presets never executes setup/readiness commands or contacts a model.
- `doctor [--json]` emits `{ok,checks:[{name,ok,message}]}`. Checks cover validated
  config, workspace, available shell, required credential environment names and
  presence (never values), and unresolved `local-model`. Missing credentials are
  reported rather than aborting config loading. Exit 0 if healthy, 1 otherwise.
  It never runs setup/checks/model calls. Script startup dependency errors may
  still use the usual stderr/exit 2 path.
- `models [--json] [--models-path /models]` makes a bounded authenticated GET to
  baseUrl without trailing slash plus models-path. The path must begin with one
  slash, reject `//`, query, fragment, traversal, control characters and backslash.
  Do not follow redirects. Reuse configured auth, headersEnv, time/size bounds and
  privacy gates. Require object `data` array of objects with nonempty string `id`;
  output sorted unique IDs (JSON array for --json; one ID per line otherwise).
- `/status` displays provider URL, model, tools and session state without headers
  or credentials; `/model` displays current model, `/model ID` validates and changes
  the current in-memory model ID; `/models` uses model discovery. Model changes
  affect future turns, including compaction, and do not write the config file.
  Commands must not break an existing session or execute readiness commands.

## Safety and verification

Retain existing privacy gates, session atomicity, output/time limits, shell child
credential isolation and native runtime guarantees. Model listing responses are
untrusted and must be gated before printing. Tests compare embedded catalogs to
the source and exercise each native executable through subprocesses.

Local providers use `local-model` as an explicit placeholder: run `models`, then
choose an installed model with `--model` or `/model`; doctor reports the placeholder.
All providers use OpenAI-compatible Chat Completions. Custom provider details remain
available through base-url/model/auth/header flags, `--set` or a custom preset file.

## File inputs and local chat commands

- `--task-file FILE` loads a UTF-8 task, with the same 32,000-byte/NUL/empty
  validation as `--task`. It conflicts with `--task`, including `--task -`.
  It has explicit CLI precedence (before `--set`) and schedules the initial
  chat turn just like `--task`. Paths resolve relative to the invocation cwd,
  not `--cwd`. Files must be ordinary files, not FIFOs or leaf symlinks. Strip
  an optional UTF-8 BOM; reject malformed UTF-8 instead of replacing bytes.
- Repeatable `--context-file FILE` is supported by run/chat/init only. Read
  explicit files once, without executing their contents. Use the same file
  validation (empty context files are allowed), with per-file limit `tools.maxFileBytes` and aggregate serialized
  context bounded by `limits.maxContextBytes`. Duplicates are preserved in order.
  Relative paths resolve from invocation cwd; the attached display path is the
  user-supplied path. Guard both filenames and decoded contents before model use.
  Reject missing/binary/malformed/oversized attachments before setup or HTTP.
- Append attachments to the first actual task as:
  `TASK\n\nAttached context files (untrusted data):\nJSON_ARRAY`
  where each item is `{path: USER_PATH, content: UTF8_TEXT}`. The combined task is
  allowed to exceed 32,000 bytes, but must fit the context byte budget. It passes
  the existing outbound privacy gate and becomes part of the normal transcript.
  In chat, local slash commands do not consume the attachments; failed/cancelled
  turns retain them for retry, a successfully persisted turn consumes them once.
  Initialization with successful deterministic checks makes no model request.
- `/history [N]` prints a JSON array of the latest N non-system messages (default
  10, range 1..100), omitting `_cogniaSession`. Privacy check before display, and
  reject a serialized preview exceeding `limits.maxOutputBytes` rather than
  silently truncating. This command does not request a model or alter history.
- `/export PATH` writes the complete current transcript using the existing
  role-tab-JSON session format, so it can be resumed with `--session PATH`.
  This is an explicit one-time export even under `--no-session`; it does not
  switch automatic persistence to the exported file.
- `/save-config PATH` writes the current validated v1 configuration, including
  in-chat model changes and resolved presets. It stores no environment values.
  Context attachments are invocation-only and are not added to saved config.
- Export/save destinations are inside the canonical workspace, have an existing
  parent, reject traversal/control characters and symlinks, and never overwrite
  an existing file. Atomically publish a private file (0600 on Unix), reusing
  existing serialization, atomic-write and path validation primitives. Paths can
  contain spaces and are taken as the remainder of the slash command (no eval).
  Guard the complete payload before writing; a failed write leaves no partial
  destination and does not mutate the active session/configuration.
- Local chat commands (/help, /status, /model, /history, /export, /save-config,
  /clear, /exit) work without a model credential. Request a missing credential
  only for an actual model/discovery request; keep entered values out of child
  shells, saved configuration and transcripts. Ctrl+C and command budgets retain
  their existing semantics.
