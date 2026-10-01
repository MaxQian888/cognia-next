# cognia-bootstrap

A small standalone coding Agent, interactive shell assistant and environment
initializer. It covers the capabilities of the inspected
[d.sh snapshot](https://github.com/SiriusNEO/d.sh/tree/f8b8ff864694624fe86157004e484f25e0397a3a),
with customizable model requests, tool grants, context management and persistent
conversation sessions. See the
[capability matrix](../../docs/plans/2026-10-01-bootstrap-agent-dsh-parity.md)
for exact compatibility and deliberate safety differences.

Independent Bash and PowerShell implementations are also available in
[`scripts/bootstrap`](../../scripts/bootstrap/README.md). They run directly from
their interpreters without this executable and can be selected in Cognia's
Bootstrap Agent environment settings.

## Quick start and configuration

```sh
# Build the single executable, then create a configuration.
cargo build -p cognia-bootstrap-agent --release
./target/release/cognia-bootstrap configure --output bootstrap.json

# The wizard saves environment references, never an API-key value.
export COGNIA_BOOTSTRAP_API_KEY='your-key'
./target/release/cognia-bootstrap chat --config bootstrap.json --cwd /workspace

# Switch model/provider for this invocation without rewriting the configuration.
./target/release/cognia-bootstrap chat --config bootstrap.json \
  --base-url https://your-compatible-provider.example/v1 --model your-model-id

# Override any validated setting, including provider-specific parameters.
./target/release/cognia-bootstrap run --config bootstrap.json \
  --task 'Inspect the failing build and repair it' \
  --set 'model.temperature=0.2' --set 'model.extraBody.parallel_tool_calls=false'

# Read a one-shot task from stdin.
printf '%s' 'Inspect this workspace' | ./target/release/cognia-bootstrap run \
  --config bootstrap.json --task -
```

`configure --non-interactive --base-url URL --model ID --output FILE` creates a
template without prompts. Existing files are protected unless `--force` is used.
In interactive chat, a missing primary credential can be entered with echo
disabled; it is held only for the invocation. Header credentials can be supplied
through their configured environment references. Noninteractive operation needs
the required environment values before launch. Use [example-chat.json](example-chat.json)
as a complete customization template and [example.json](example.json) for init.

Settings precedence is configuration file, environment overrides, dedicated CLI
flags, then `--set`. Overrides use `dotted.path=JSON`; `/json/pointer=JSON` supports
keys containing dots/slashes and array elements. String values need JSON quotes.
All overrides pass the same validation as saved configuration.

| Area           | Configurable fields                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model/provider | `model.baseUrl`, `model.model`, `endpointPath`, `requestTimeoutSecs`, `auth` (`bearer`, `header`, `none`), `apiKeyEnv`, `apiKeyHeader`            |
| Request        | `stream`, `showThinking`, `maxTokens`, `temperature`, `topP`, `seed`, `reasoningEffort`, explicit `thinking`, `extraBody`                         |
| Headers        | `headers` for ordinary values; `headersEnv` maps header names to credential environment names                                                     |
| Persona        | Top-level `systemPrompt`                                                                                                                          |
| Tools          | `tools.shell`, `editor`, `profile` (`native`, `dsh`), `shellExecutable`, `shellArgs`, `environment`, `maxFileBytes`                               |
| Context        | `contextWindowTokens`, `autoCompact`, `compactThresholdTokens`, `compactRetainTokens`, `compactMaxTokens`, `compactRetries`, `maxOverflowRetries` |
| Pruning        | `pruneToolResults`, `pruneThresholdBytes`, `pruneHeadBytes`, `pruneTailBytes` in `context`                                                        |
| Budgets/reuse  | Every `limits` field and `reuse.inputs`/`outputs`                                                                                                 |

The wire protocol is **OpenAI Chat Completions**. Model IDs are arbitrary; a
provider must implement that protocol and the chosen parameters. Native
Anthropic/Gemini APIs need a compatible gateway. Unsupported request parameters
remain provider errors; Cognia does not silently change the selected model.
`extraBody` accepts provider extensions but cannot override the protocol fields
or contain credential keys. Sensitive headers must use environment references.
Requests support HTTPS and explicit literal-loopback HTTP endpoints. `endpointPath`
is a suffix relative to `baseUrl`; an already-complete default `/chat/completions`
endpoint is also accepted. Automatic redirects and TLS bypass stay disabled.

## Chat, sessions and context

Interactive commands: `/compact` summarizes earlier context; `/clear` clears the
transcript and resets the shell; `/help` lists commands; `/exit` or `/quit` exits.
Ctrl+D exits; Ctrl+C cancels the current request/tool and returns to the prompt.
SIGTERM exits and releases child process groups. Cancellation does not undo
filesystem changes already made by completed tools.

Chat defaults to `session.jsonl` in the selected workspace. `--session PATH`
selects another file; `--no-session` disables persistence. One-shot `run` uses a
session only when requested by the flag or session environment override. Sessions
use the d.sh role-TAB-JSON format with optional Cognia turn-boundary metadata,
0600 permissions, an exclusive lock and atomic writes. Only finished user turns
are committed; malformed/incomplete tails are discarded on resume. Metadata is
removed before model replay. The currently selected persona applies after resume.
Shell state persists across turns in one process and starts fresh after restart.

Automatic compaction prunes large tool output first, then summarizes earlier
complete exchanges while retaining recent exchanges and the current task. Manual
compaction works independently of `autoCompact`. Overflow recovery is bounded by
`maxOverflowRetries`; unusable summaries do not replace history. Token counts
are conservative estimates, while serialized-byte limits independently cap
context memory. Summary requests pass the same credential/PII gate as normal
requests, and use `compactMaxTokens` with tools excluded.

SSE responses assemble text, reasoning and fragmented tool calls. CLI text and
optional thinking appear only after the complete response passes the privacy
gate, so output is buffered rather than displayed token by token. All tool calls
are validated before any execute; unfinished streams never execute tools.

Legacy environment names are supported: `BASE_URL`, `MODEL_NAME`, `DSH_CWD`,
`DSH_SESSION_FILE` (empty disables), `DSH_MAX_TOKENS`, `DSH_MAX_STEPS`,
`DSH_COMMAND_TIMEOUT`, `DSH_API_TIMEOUT`, `DSH_STREAM`, `DSH_SHOW_THINKING`,
`DSH_SYSTEM_PROMPT`, `DSH_CONTEXT_WINDOW`, `DSH_AUTO_COMPACT`,
`DSH_COMPACT_THRESHOLD`, `DSH_COMPACT_RETAIN`, `DSH_COMPACT_MAX_TOKENS`,
`DSH_COMPACT_RETRIES`, `DSH_MAX_OVERFLOW_RETRIES`, `DSH_REASONING_EFFORT`.
The reasoning compatibility override maps `none` to disabled DeepSeek thinking,
and other efforts to enabled thinking; ordinary JSON model fields are explicit
and provider-neutral. Cognia-prefixed aliases take precedence; see CLI tests
for the exact mapping. The API key comes from the configured `apiKeyEnv`.

## Cognia environment settings

Open a workspace's environment manager, select/create an environment and enable
Bootstrap Agent. Set the task, compatible endpoint, model ID and readiness
checks. The advanced section exposes tool/context/budget controls and a JSON
editor for complete `modelOptions`, `context`, `tools`, `reuse` and byte budgets.
Invalid drafts are displayed and reject enabled save/run. Bearer/custom-header
credentials must reference environment keyring entries; auth `none` requires no
model key. Advanced settings persist through environment versions and invalidate
setup reuse when they change. Cognia continues to run `init`, not a background
chat session, when preparing the environment.

## Initialization and execution contract

A standalone task utility and environment initializer. The executable needs no
Tauri, Node, Python, sidecar, desktop app, or background service. Build with
`cargo build -p cognia-bootstrap-agent --release`; copy the resulting
`target/release/cognia-bootstrap` into the selected environment. Unix platforms
require an available shell. It executes commands with the invoking user's
permissions; run it inside the intended disposable container or environment.

```sh
cognia-bootstrap run --config task.json --cwd /workspace
cognia-bootstrap init --config example.json --cwd /workspace --state /workspace/.bootstrap-state.json
cognia-bootstrap init --config-env BOOTSTRAP_CONFIG --cwd /workspace --then -- your-agent serve
```

The model API key comes only from `model.apiKeyEnv` (default
`COGNIA_BOOTSTRAP_API_KEY`), is used only in the selected HTTP authentication header, and
is removed from tool/check/handoff processes. Never put a credential in config.
Optional `secretEnv` lists other credential environment variable names (max128
unique identifiers). Adaptive tools and all readiness checks scrub these values.
Only fixed setup scripts, before any adaptive execution, may inherit explicitly
listed credentials to access private packages;
their output is checked against exact values and the PII gate before any model
request. The model API credential is always excluded from this trusted list.
Readiness checks never receive configured credentials, because the adaptive
agent can modify workspace scripts that those checks invoke.
Configuration, task, history, and tool results pass the shared native outbound
PII gate before each HTTP request; recognized private content fails closed.
Network errors, malformed provider responses, and configuration errors produce
stable error codes without response bodies, credentials, or raw diagnostics.

`run` executes an autonomous task. Optional checks must pass before completion.
`init` requires named fresh-shell readiness checks: initial successful checks
skip the model and do not require an API key. Otherwise the deterministic
`setupCommand` runs, checks run again, and the agent repairs remaining failures.
Each model turn is one step; retries are capped at three attempts and happen
only for HTTP 429/5xx. After each initialization tool batch, fresh checks run
again, so the final budgeted repair step can establish readiness directly.
Readiness comes from exit code zero for every check, never
model prose or functions/exports left in the persistent agent shell.

`init --force` skips initial checks and runs initialization again. With `--state`,
initializations serialize through an OS file lock; an atomic record stores only
a SHA-256 fingerprint of canonical cwd, normalized config, and declared input
file contents. Successful checks always run again before reuse, and declared
outputs must exist without symlinks. Changed config/inputs or missing outputs
invalidate reuse and rerun setup even if presence-only readiness checks pass;
configured inputs must be regular files, at most 16 MiB each. State and lock
parents must already exist. The state contains no transcript or credential.

`--then -- PROGRAM ARG...` is accepted only for `init` and launches the exact
argv after checks establish readiness, with inherited standard streams. Its
exit code propagates. Initialization's total budget ends before handoff; the
launched application has its own lifetime. SIGINT/SIGTERM cancel execution and
terminate process groups, including handoff children.

`run` and `init` output one JSON line with `version`, `status`, `steps`, `message`, `checks`,
`reused`, and optional `errorCode`. Status values are `ready`, `completed`,
`failed`, `cancelled`, `budget-exhausted`. Exit codes: 0 success, 1 failure,
2 invalid invocation/config, 3 exhausted step/time/context budget, 130 cancelled.
With handoff, this record appears before application output; failed handoff
emits another failure record. The caller must parse lines accordingly.

The camelCase JSON contract rejects unknown fields. `version` is 1; `task` is
nonempty (32,000 bytes max); `model` requires `baseUrl` and `model`. HTTPS is
required except literal loopback IP/localhost HTTP for local providers/tests;
userinfo, query, fragments, redirects, and TLS certificate bypass are forbidden.
On standalone startup, conventional proxy environment variables initialize the
shared routing policy; an already initialized host policy remains authoritative.
The default base path receives `/chat/completions`. `requestTimeoutSecs` defaults to 60
(1–600). API env names must be identifiers, at most 128 bytes. Model names are
nonempty, at most 256 bytes, without controls.

`checks` defaults empty for run (max 64, unique ASCII names at most 128 bytes,
commands nonempty at most 32,000 bytes). `setupCommand` is optional, nonempty,
and at most 32,000 bytes. `reuse.inputs`/`outputs` default empty; each list holds
at most 128 distinct relative normal paths. Limits default to `example.json`:
`maxSteps` 1–256, `totalTimeoutSecs` 1–86400, `commandTimeoutSecs` 1–3600,
`maxOutputBytes` 256–1048576, `maxContextBytes` 4096–8388608,
`maxResponseBytes` 1024–8388608. Budgets include model requests, retries, setup,
tools, state locking, and readiness checks. Context compaction retains complete
exchanges and the original system/task; if the latest exchange
cannot fit, execution fails explicitly.
`maxContextBytes` bounds serialized message history; the HTTP envelope and fixed
tool schemas add a small, fixed overhead outside that message budget.
Validated optional `reasoning_content` is replayed within the same complete
assistant/tool exchange and shares the context/PII budgets. This supports
providers whose thinking tool turns require it, as documented by
[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/).

The native profile exposes `shell` and `editor`. The DSH profile exposes `bash`
and `str_replace_editor`, including numbered file/directory views, unique
replacement, omission-to-delete and insertion **after** `insert_line` (0 prepends).
The native editor retains insertion **before** a one-based line. Both profiles
confine text editing to the canonical workspace without following symlinks.
The default Bash shell uses `--noprofile --norc`; set `shellArgs: []` when choosing
`/bin/sh`. `maxFileBytes` is configurable from 1 KiB to 16 MiB (default 4 MiB).
Custom shell environment cannot contain credential or startup-injection variables.
All calls in a model turn are validated
before any one is dispatched. Tools preserve real exit status, bound output,
and report timeout/reset. They are not an OS security sandbox; shell commands
can access the invoking user's resources. Install into an appropriate isolated
environment and supply a narrowly scoped key.

Implementation is original Cognia code. No d.sh source was copied.
