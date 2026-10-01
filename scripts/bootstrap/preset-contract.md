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
