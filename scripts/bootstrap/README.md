# Standalone bootstrap Agents

Each script runs the Agent itself and can be copied independently of this
repository. Neither invokes the Cognia executable, Node, Tauri or a server.

| Script                 | Runtime requirements                                                | Default command language |
| ---------------------- | ------------------------------------------------------------------- | ------------------------ |
| `cognia-bootstrap.sh`  | Bash 3.2+, curl, jq 1.6+ and standard Unix utilities on macOS/Linux | Bash                     |
| `cognia-bootstrap.ps1` | PowerShell 7.4+ on Windows/macOS/Linux                              | PowerShell               |

The shared version-1 JSON configuration and `configure`, `run`, `chat`, `init`
commands follow the [native Agent contract](../../crates/cognia-bootstrap-agent/README.md).
Provider IDs, URLs, authentication, headers, request parameters, persona,
tool grants, context policy and execution budgets remain customizable.
The provider must expose an OpenAI Chat Completions compatible API.

## Bash

From the repository root:

```bash
bash scripts/bootstrap/cognia-bootstrap.sh configure --output bootstrap.json
bash scripts/bootstrap/cognia-bootstrap.sh chat --config bootstrap.json --cwd "$PWD"

printf '%s' 'Inspect this workspace' | bash scripts/bootstrap/cognia-bootstrap.sh \
  run --config bootstrap.json --task -

bash scripts/bootstrap/cognia-bootstrap.sh run --config bootstrap.json \
  --model your-model-id --base-url https://your-compatible-provider.example/v1 \
  --set 'model.temperature=0.2'
```

Copy only `cognia-bootstrap.sh` to use it elsewhere. Bash implements the Agent
loop, tools, sessions and initialization; curl provides HTTP and jq handles JSON.
No Python, Node, compiled Cognia binary or sibling runtime file is needed.
SHA-256 fingerprints use `sha256sum` when available, otherwise `openssl`.

## PowerShell

Use `pwsh` (PowerShell 7), including on Windows:

```powershell
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 configure --output bootstrap.json
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 chat --config bootstrap.json --cwd .

'Inspect this workspace' | pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 `
  run --config bootstrap.json --task -

pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 run --config bootstrap.json `
  --model your-model-id --base-url https://your-compatible-provider.example/v1 `
  --set 'model.temperature=0.2'
```

Copy only `cognia-bootstrap.ps1`. It implements the Agent in PowerShell and uses
the included .NET libraries directly, without compiling an embedded C# engine.
Windows PowerShell 5.1 (`powershell.exe`) is not supported. Install
PowerShell using [Microsoft's installation guide](https://learn.microsoft.com/powershell/scripting/install/installing-powershell).

Credentials are environment references in configuration, never literal values.
Interactive chat can prompt privately for a missing API key. For unattended
initialization, provide the configured key through your environment or Cognia's
keyring references. No model key is needed when deterministic setup and
readiness checks succeed.

## Presets and quick configuration

Both standalone runtimes provide the same built-in catalog:

| Kind           | IDs                                                      | Effect                                                                  |
| -------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Provider       | `deepseek`, `openai`, `openrouter`, `ollama`, `lmstudio` | URL, initial model, authentication and credential environment reference |
| Task           | `coding`, `debug`, `chat`, `quick`, `explain`            | Task instructions, tool grants and execution/output budgets             |
| Initialization | `node-pnpm`, `python-uv`, `rust`, `go`                   | Setup command, readiness checks, reuse inputs/outputs and time budgets  |

`chat` and `explain` disable workspace tools. `coding`, `debug` and `quick` allow
shell and editor operations. These are starting configurations, not permission
sandboxes. All generated fields remain editable.

```bash
bash scripts/bootstrap/cognia-bootstrap.sh presets
bash scripts/bootstrap/cognia-bootstrap.sh configure --provider deepseek --preset coding \
  --non-interactive --output bootstrap.json
# Supply DEEPSEEK_API_KEY through your environment.
bash scripts/bootstrap/cognia-bootstrap.sh doctor --config bootstrap.json
bash scripts/bootstrap/cognia-bootstrap.sh models --config bootstrap.json
bash scripts/bootstrap/cognia-bootstrap.sh chat --config bootstrap.json
```

```powershell
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 configure `
  --provider deepseek --preset coding --non-interactive --output bootstrap.json
# Supply DEEPSEEK_API_KEY through your environment.
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 doctor --config bootstrap.json
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 models --config bootstrap.json
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 chat --config bootstrap.json
```

Provider presets are based on the providers' OpenAI-compatible endpoints:
[DeepSeek](https://api-docs.deepseek.com/),
[OpenAI](https://developers.openai.com/api/docs/models/gpt-4.1-mini),
[OpenRouter](https://openrouter.ai/docs/quickstart),
[Ollama](https://docs.ollama.com/api/openai-compatibility), and
[LM Studio](https://lmstudio.ai/docs/developer/openai-compat/models).
Account model access and local model installation must be checked on your host.
Ollama and LM Studio use `local-model` as a placeholder and no authentication by
default. Select an installed model before starting:

```bash
bash scripts/bootstrap/cognia-bootstrap.sh models --provider ollama
bash scripts/bootstrap/cognia-bootstrap.sh chat --provider ollama --model YOUR_INSTALLED_MODEL --preset chat
```

Any other compatible provider can be configured with `--base-url`, `--model`,
`--api-key-env`, `--set`, or custom preset files. For an authenticated local server,
set `model.auth` to `"bearer"` and select its credential environment name.

`doctor` checks configuration, workspace, shell availability, credential presence
and the local-model placeholder. It neither contacts a provider nor runs setup or
readiness commands. A successful doctor result does not prove model access.
`models` performs an authenticated, bounded GET request; `--models-path /catalog/models`
overrides the default `/models` suffix. Redirects are rejected. `presets`, `doctor`
and `models` accept `--json` for machine-readable output.

### Custom preset files and precedence

A custom preset is a partial v1 JSON configuration. For example, save this as
`team-preset.json`:

```json
{
  "model": { "temperature": 0.2, "maxTokens": 4096 },
  "tools": { "profile": "dsh" },
  "limits": { "maxSteps": 24 },
  "reuse": { "inputs": ["package.json", "pnpm-lock.yaml"], "outputs": ["node_modules"] }
}
```

```bash
bash scripts/bootstrap/cognia-bootstrap.sh configure --provider deepseek --preset coding \
  --preset-file team-preset.json --model deepseek-flash --set 'limits.maxSteps=32' \
  --non-interactive --output bootstrap.json
```

Precedence is defaults → config → provider → task preset → recipe → custom files
in argument order → environment overrides → explicit CLI flags → `--set` entries.
Objects merge recursively; arrays and `null` replace earlier values. Selecting a
provider resets the entire previous model configuration, including headers,
authentication and provider-specific parameters. Subsequent explicit overrides
can then customize it. Unknown IDs and unknown configuration fields are errors.
Secrets remain environment references; never put a key value in a preset file.

The catalog source is [presets.json](presets.json). Each script embeds the catalog,
so copying a script does not require copying that file. Presets expand into the
existing v1 JSON format; the Rust executable can consume the expanded file, while
the new preset/diagnostic CLI commands are provided by the standalone scripts.

### Initialization recipes

Applying a recipe only writes configuration. Installation starts with an explicit
`init` invocation:

```bash
bash scripts/bootstrap/cognia-bootstrap.sh configure --provider deepseek --recipe node-pnpm \
  --non-interactive --output bootstrap.json
bash scripts/bootstrap/cognia-bootstrap.sh init --config bootstrap.json --cwd "$PWD" \
  --state .bootstrap-state.json
```

Recipes expect the named package manager and project/lock files to exist. They
do not install pnpm, uv, Rust or Go themselves. Setup uses locked dependencies:
`pnpm install --frozen-lockfile`, `uv sync --frozen`, `cargo fetch --locked`, or
`go mod download`. Readiness checks verify dependency output, virtual environment,
offline compilation or module integrity respectively. Adjust checks to suit your
project. Go module caches live outside the workspace; its recipe therefore declares
no workspace output directory and always reruns `go mod verify` before reuse.

PowerShell recipes choose commands for the resolved execution shell. Bash uses a
POSIX shell; PowerShell execution requires the PowerShell standalone runtime.
Reapply a recipe after changing the execution shell to update its check commands.

## Initialization

The examples demonstrate deterministic setup without a model request:

```bash
bash scripts/bootstrap/cognia-bootstrap.sh init \
  --config scripts/bootstrap/example.bash.json --cwd "$PWD" --state .bootstrap-state.json
```

```powershell
pwsh -NoProfile -File ./scripts/bootstrap/cognia-bootstrap.ps1 init `
  --config ./scripts/bootstrap/example.powershell.json --cwd . --state .bootstrap-state.json
```

Replace `setupCommand` and `checks` with your actual installation and verification
commands. The PowerShell default uses PowerShell syntax; selecting a runtime
does not translate existing Bash setup commands. An explicitly configured shell
executable and its arguments take precedence over each runtime's defaults.

`init --then -- PROGRAM ARG...` launches the exact command only after fresh
readiness checks pass. State files contain reuse hashes, while optional session
files contain completed conversations. A changed configuration/input or missing
declared output forces setup again.

## Cognia environment settings

Enable Bootstrap Agent in a workspace environment and select **Agent runtime**:
native, standalone Bash or standalone PowerShell. Set **Bootstrap executable**
to the script's path on the execution host. Install the selected interpreter on
that host too. PowerShell supports the Windows launch path; Bash/native use a
Unix execution host. Environment versions, rollback and setup fingerprints
include this selection.

The **Starting configuration** controls apply provider settings, task settings or an initialization
recipe to the editable form. A recipe updates the environment setup script and
Bootstrap readiness checks together. Save the environment to persist the result;
applying a preset does not execute it. Provider selection clears previous provider
options, so add custom headers or authentication after selecting the provider.

## Sessions, tools and limits

Chat accepts `/status`, `/model`, `/model ID`, `/models`, `/compact`, `/clear`,
`/help`, `/exit` and `/quit`. `/status` displays the active provider, model, tools
and session state. `/model ID` switches the model for subsequent requests, including
compaction, without rewriting the configuration file. `--session PATH`
selects a transcript; `--no-session` disables persistence. Chat's default is
`session.jsonl` in the workspace. Sessions save complete turns atomically, and
the shell retains variables, functions and cwd during the current process.
`/clear` resets both the transcript and shell.

Both implementations bound requests, tool output, command duration and total
execution. They support automatic/manual compaction, pruning, context-overflow
recovery and fragmented SSE. Response text is buffered until the full response
passes credential/PII checks. Credentials are scrubbed from adaptive child shells
and readiness checks. Editor operations stay within the selected workspace and
reject symlinks/reparse points. Shell execution uses the caller's permissions;
it is not an OS sandbox.

## Verification

The durable local-provider acceptance suite runs the actual scripts and child
shells. Python is used only by this development test harness, never by either
Agent runtime:

```bash
python3 scripts/bootstrap/standalone.test.py --runtime bash
python3 scripts/bootstrap/standalone.test.py --runtime powershell
python3 scripts/bootstrap/bash-runtime.test.py
python3 scripts/bootstrap/powershell-runtime.test.py
# Set COGNIA_TEST_PWSH to an explicit pwsh executable if it is not on PATH.
```

The shared suite includes a copied-file test with Python, Node and the Cognia
executable blocked, plus checks against embedded language engines. Bash's
boundary suite also runs the shared tests; PowerShell's boundary suite adds
interpreter-specific cases.

The workflow in `.github/workflows/bootstrap-scripts.yml` runs Bash and PowerShell
on Linux and PowerShell on Windows. Local verification uses macOS ARM, Bash
3.2.57 and PowerShell 7.6.6 with both a synthetic HTTP provider and authenticated
DeepSeek `deepseek-flash`. Windows/Linux execution has not been verified locally.
The [live validation report](live-validation-2026-10-01.md) records eight passing
scenarios, two repaired defects and an unresolved earlier privacy-gate block.

Verified on 2026-10-01 after the preset expansion: Bash's full boundary suite
passed 67/67 tests (including 50 shared contracts); PowerShell passed 50/50
shared and 10/10 specific contracts. Seven Cognia integration suites passed
202/202 tests. The final authenticated preset flow passed 14/14 checks, including
real editor/shell calls and pnpm initialization/reuse. See the
[preset validation report](preset-validation-2026-10-01.md) for source hashes,
measurements, repaired privacy false positives and repository-wide gate limits.
