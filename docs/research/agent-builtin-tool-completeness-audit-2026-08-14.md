# Built-in Agent tool completeness audit (2026-08-14)

Supersedes parts of [`agent-built-in-tool-gap-analysis-2026-07-18.md`](./agent-built-in-tool-gap-analysis-2026-07-18.md) — see §11.
中文版：[`agent-builtin-tool-completeness-audit-2026-08-14.zh.md`](./agent-builtin-tool-completeness-audit-2026-08-14.zh.md)。

This is an audit artifact, not an ADR. It records what the built-in agent tool surface
did **as of 2026-08-14, before remediation**, measured against three axes, with `file:line`
evidence for every claim. No production code was changed while producing the audit itself.

> **REMEDIATION IN PROGRESS.** A first pass has since landed against the security tier and
> the highest-severity P0s. Findings marked ✅ below are fixed; the `file:line` citations in
> those sections describe the **pre-fix** code and will no longer match `main`. Everything
> unmarked is still open and its citations remain accurate.
>
> **Fixed — security tier.** **SEC-1, SEC-2, SEC-3** (confinement now classifies every
> mutating and path-bearing read tool, `collectPathTargets` reads all 17 path keys plus
> `paths[]` and collects _every_ present key rather than first-match, and the `file-ops`
> mutators call `assertNotSecretEscape` — transfers guard both source and destination) ·
> **SEC-4** (`revealSecrets` removed from `get_env`/`list_env`) · **SEC-6** (both deny
> lists derived from `requiresApproval` metadata; `CORE_MUTATING_TOOL_NAMES` wired in) ·
> **SEC-7** (`kill_shell` re-tiered) · **SEC-8** (the Anthropic rail now enforces plan
> mode over the two cognia-owned MCP servers, deferring SDK-native and user MCP tools to
> the SDK) · **SEC-12** (the external-agent bridge validates input against each tool's zod
> shape, after authorisation).
>
> **Fixed — P0.** **P0-1** (`bash` spawn failures and signal kills return `isError`) ·
> **P0-2** (the JSON-Schema→zod conversion now preserves `enum`/`const`, string/number/
> array bounds, `default`, and nested `properties`/`required` instead of collapsing
> objects — verified by direct parse tests) · **P0-4** (the Monitor family is no longer
> advertised on the bridge, where it could never work; `sessionId` is threaded) · **P0-6**
> (`lsp`/`codeGraph` denied when the resolver is absent) · **P0-7** (the error text no
> longer steers the model to a `file_delete` tool that does not exist) · **P0-8**
> (`ast_grep_*` run in the session cwd) · **P0-9** (interrupted rewrite returns an error) ·
> **P0-11** (`impactCount` reports `impactCountExact`).
>
> **Fixed — P1/P2.** **P1-1** (the ai-sdk rail forwards `AbortSignal` into handlers;
> `grep`/`glob` and `ast_grep_*` now consume it, so an interrupt kills the child instead of
> orphaning it) · **P1-4** (one shared `plan-mode-policy.mjs` replaces the drifted copies) ·
> **P2-0** (**fully closed** — 167/167 sidecar test files now run, 1428 → 1726 tests
> gated; completed jointly with a parallel fix to the root suites) · the 9 missing i18n
> keys in §7, plus new `sdk-native` labels.
>
> **SEC-5 partially fixed.** The two cheap parts landed: `SDK_CORE_TOOL_NAMES` expanded, and
> SDK-native tools added as a fifth `lib/tools/tool-catalog.ts` source (with both UI source
> lists and their i18n wired, or the entries would have been silently dropped). The core
> defect — `allowedTools` meaning pre-approval on one rail and a whitelist on two others —
> is **not** fixed; it needs a product decision.
>
> **P0-3 deliberately left open.** Blanket-mapping `ok: false` onto `error` was attempted
> and reverted: it contradicts a tested design decision that a refusal is a structured
> result, not a tool error. See the note in `lib/claude/plugin-tool-ipc.ts`. Closing it
> needs a per-tool refusal-vs-error decision plus the P1-2 envelope unification.
>
> **SEC-9 fixed.** The two secret sets are now the UNION of both sides (`.gpg`,
> `.config/gcloud`, `.config/gh`, `.git-credentials`, `_netrc`, `.pypirc` were sidecar-only;
> `.cognia`, `.npmrc`, `.pgpass`, `id_rsa`, `id_ed25519`, `known_hosts` were CLI-only). The
> CLI gained symlink resolution and cross-separator splitting, both sides now case-fold on
> macOS as well as Windows, and the CLI's path-key list gained `workdir`, `output`,
> `oldPath`/`newPath`, `pathA`/`pathB` and array-valued `paths[]`. The two enforcement
> points stay separate on purpose — Cognia must not trust a check running inside the
> process it confines — but the data no longer drifts. Verified: 16/16 credential paths
> denied, a normal project path still allowed.
>
> **P0-13 fixed.** The supervisor path — the one that actually runs in every production
> wiring — now records the pid, so `get_tracked_processes` is no longer permanently empty,
> `get_process_manager_status` no longer claims `enabled: true` for an unfillable registry,
> and `terminate_process` no longer refuses pids it just spawned.
>
> **P1-5 partially fixed.** `list_shells` surfaces a host failure instead of reporting zero
> shells, and `git_stage` reports what the index actually holds (`git add` exits 0 having
> staged nothing when paths are ignored or unchanged). The remaining swallowed-error sites
> in that finding are untouched.
>
> **Still open:** SEC-5 (core), **SEC-10, SEC-11**, **P0-3, P0-5, P0-10, P0-12**,
> **P1-2, P1-3, P1-6, P1-7** and the rest of P1-5, and the remainder of **§7**. §9's
> implementation chapter is untouched.

---

## 1. Summary

The tool surface is broad and, by the measure the repo currently enforces, healthy: the
metadata↔implementation parity gate is green and all 1428 sidecar tests pass. The defects
are almost entirely **outside** what that gate can see.

Three structural facts explain nearly every finding:

1. **The parity gate is largely tautological.** It asserts `READ_ONLY_TOOL_NAMES` _equals_
   the set of `requiresApproval === false` tools, which enforces consistency with whatever
   value is in the JSON without ever checking that the value is correct. `kill_shell` is
   declared read-only; the gate then propagates that to four permission gates. Likewise
   `TOOL_NAMES_BY_CATEGORY` is derived from the same JSON it is compared against, so only
   `coreFiles` has a real registration-order gate.
2. **Workspace confinement is opt-in by tool name, and 23 of 28 mutating tools never opted
   in.** `classifyToolCallConfinement` returns `null` — no opinion — for any name outside
   three hardcoded sets, and `null` then satisfies every `!== "ask"` guard downstream.
3. **`allowedTools` means two contradictory things depending on the provider.** On the
   Anthropic rail it is pre-approval and does not restrict anything; on the AI-SDK and CLI
   rails it is an exhaustive whitelist.

The single most reachable defect: in `acceptEdits` mode — a common, non-default setting —
`file_binary_write` and `file_append` are auto-approved, are invisible to confinement, and
carry no credential backstop. Writing an attacker key to `~/.ssh/authorized_keys` produces
no prompt, in direct contradiction of the invariant the code claims to hold in every mode.

Counts: **83** sidecar built-ins + **~35** host-routed + **5** A2UI + **3** native-Anthropic.
**9** canonical tools absent, of which **6 already ship natively** in the vendored SDK.

---

## 2. Scope, denominators, method

**Audited in full** (every handler read top to bottom, every declared schema key traced to a
use site or judged phantom):

| Family                               | Source of truth                                   | Count |
| ------------------------------------ | ------------------------------------------------- | ----- |
| A — sidecar built-ins                | `lib/settings/builtin-tools-data.json`            | 83    |
| B — host-routed "promoted" built-ins | none — 12 scattered `is*BuiltinTool()` predicates | ~35   |
| A2UI bridge                          | `sidecar/a2ui-tools/tool-defs.mjs`                | 5     |

**Quick-checked into the appendix**: `lib/plugin/registries/native-anthropic-tool-registry.ts` (3).

**Three gap axes:**

1. **Contract self-consistency** (hard floor) — a declared parameter must be read and take
   effect. Default resolution for a divergence is _implement the parameter_.
2. **Canonical toolset** as a blind-spot checklist, not a spec to copy.
3. **Subsystem reachability** — denominator is the ~40-row Subsystem Map in `CLAUDE.md`.

**Definition of complete**, per tool: honours every declared parameter · honours an
`AbortSignal` · returns the unified result/error envelope · registered in the permission
catalog at a tier matching its side effects · shell availability declared and pinned by a test.

**Cross-shell rule**: capability matrix plus testable degradation. A degradation is a _bug_
only when the host has the capability and fails to inject it; a genuine environment limit
stays a degradation but must return a structured error naming the cause.

**Measured baselines** (not assumed): `pnpm sidecar:test` → 1428 tests, 1426 pass, 0 fail.
`pnpm lint:i18n` → OK, and its own output shows why it cannot catch §7's i18n gap: _"21065
literal refs, 1327 dynamic skipped"_.

**That first baseline is narrower than it looks** — see P2-0. `sidecar:test:builtin` globs eight
directories and misses five, so 17 co-located test files never run in CI. Executed directly they
are green (137 tests, 137 pass), but they gate nothing. One of them is `confinement.test.mjs`,
which pins the exact classification behaviour behind SEC-1 and SEC-2.

**Not established by runtime invocation.** Behaviour was established by reading code, running
the existing suites, and statically tracing dependency injection. Two claims below are marked
as empirically verified because a sub-agent executed the handler directly; everything else is
static. §12 lists what that leaves open.

---

## 3. Severity model

- **SEC** — the system tells the _user_ something false about its own protections. Ranked
  above everything else.
- **P0** — the system tells the _model_ something false: phantom parameters, silent failure,
  swallowed errors, advertised-but-dead tools. These make the agent reason from false premises.
- **P1** — works, but not robust: no cancellation, inconsistent envelopes, broken bookkeeping.
- **P2** — hygiene: missing tests, missing catalog entries, dead constants.

---

## 4. Security findings

### SEC-1 — `acceptEdits` auto-approves two writers that confinement cannot see

`ACCEPT_EDITS_TOOL_NAMES` (`sidecar/dispatch/ai-sdk-tools.mjs:68-76`) contains `file_append`
and `file_binary_write`. Neither appears in `WRITE_TOOLS` / `READ_TOOLS` / `BASH_TOOLS`
(`sidecar/builtin-tools/confinement.mjs:134-146`), so `classifyToolCallConfinement` returns
`null` at `:198`. The auto-approval guard is `confVerdict !== "ask"`
(`ai-sdk-tools.mjs:325`) — and `null !== "ask"` is true. Neither handler calls
`assertNotSecretEscape`; the only five call sites are `core/write.mjs:58`,
`core/edit.mjs:121` and `:154`, `core/notebook-edit.mjs:64`, `core/apply-patch.mjs:125`.

```jsonc
// acceptEdits mode, fileExtras is ON by default (packages/agent-config-types/src/index.ts:211-224)
{
  "tool": "mcp__cognia-tools__file_binary_write",
  "path": "/Users/me/.ssh/authorized_keys",
  "data": "<base64 key>",
  "createDirectories": true,
}
```

No prompt, no verdict, no backstop. `ai-sdk-tools.mjs:229-231` states a credential-path deny
"is a hard security invariant enforced in EVERY mode, including bypassPermissions". It is not.

The comment on `ACCEPT_EDITS_TOOL_NAMES` shows the scope _was_ considered — it deliberately
excludes exec, process, git-mutation, and rename/move ops. The error is that two of the
tools it did include are exactly the two with no confinement coverage.

**Fix:** add every mutating tool to `WRITE_TOOLS`, and extend `collectPathTargets`
(`confinement.mjs:155-166`) beyond `file_path`/`path`/`workdir`. Add `assertNotSecretEscape`
to every `file-ops/` handler.

### SEC-2 — Confinement classifies 5 of 28 mutating tools

`classifyToolCallConfinement` gives **no verdict** for: `apply_patch`, `Monitor`,
`file_append`, `file_binary_write`, `file_copy`, `file_rename`, `file_move`,
`directory_create`, `directory_delete`, `git_stage`, `git_commit`, `start_process`,
`terminate_process`, `shell_execute_advanced`, `terminal_repl_spawn`, `terminal_repl_write`,
`terminal_repl_kill`, `ast_grep_replace`, `clone_dep_source`, `web_clone`, `web_clone_convert`.

`directory_delete` is the sharpest: `fsp.rm(path, {recursive})` (`file-ops/directory-ops.mjs:48`)
against any directory on the machine, with no verdict even under `bypassPermissions`.

Compounding it, `collectPathTargets` reads only `file_path`, `path`, `workdir`. It does not
read `source`, `destination`, `oldPath`, `newPath`, `directory`, `cwd`, `output`, `pathA`,
`pathB`, `paths[]`, `globs[]`, or the paths embedded in `apply_patch`'s diff body — so several
tools would still collect nothing even if added to the sets. The `else if` at `:163-164` also
means a tool carrying both `file_path` and `path` only ever gets the first checked.

### SEC-3 — The read side leaks credentials that `Read` is denied

`confinement.mjs:18-19` promises "read whole machine except secrets". Only `read`/`ls`/`grep`/
`glob` get that deny. These are `requiresApproval: false`, hence auto-allowed in plan mode,
`dontAsk`, and headless:

| Tool             | Param                                            | Effect                                                                   |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `content_search` | `directory` (`file-ops/content-search.mjs:42`)   | `{directory:"~/.ssh", pattern:"PRIVATE KEY"}` returns **matching lines** |
| `file_diff`      | `pathA`,`pathB` (`file-ops/file-diff.mjs:18-19`) | prints **full file contents** as a patch                                 |
| `file_search`    | `directory` (`file-ops/file-search.mjs:15`)      | enumerates `~/.aws`, `~/.gnupg`, `~/.kube`                               |
| `file_hash`      | `path` (`file-ops/file-hash.mjs:14`)             | key-rotation oracle                                                      |

So `Read("~/.ssh/id_rsa")` is denied while `file_diff` returns the same bytes unprompted.

### SEC-4 — `get_env` / `list_env` hand out secrets under a read-only tier

Both are `requiresApproval: false`. `get_env` accepts `revealSecrets: true`
(`sidecar/builtin-tools/environment.mjs:83-108`), which bypasses redaction. The module comment
at `:5-6` claims the flag "is gated by the per-call approval flow at the parent" — there is no
such gate; `revealSecrets` has no consumer outside that file. The sidecar's own `process.env`
carries `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
(`sidecar/dispatch/subprocess-env.mjs:12`, asserted in `subprocess-env.test.mjs:27-29`).

Reachable in plan mode (`ai-sdk-tools.mjs:262-270`), `dontAsk` (`:286`), and headless
(`:358-364`). The headless block's comment says read-only built-ins "cannot mutate the host" —
true, and beside the point: they can exfiltrate it.

### SEC-5 — `allowedTools` is pre-approval on one rail and a whitelist on two others

| Rail      | Semantics                           | Evidence                                                                                                                                                                                 |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic | **pre-approval; does not restrict** | vendored `sdk.d.ts:1393-1399`: _"tool names that are auto-allowed without prompting… To restrict which tools are available, use the `tools` option instead."_ Cognia never sets `tools`. |
| AI-SDK    | **exhaustive whitelist**            | `ai-sdk-tools.mjs:141` `passesAllowList`                                                                                                                                                 |
| CLI host  | **exhaustive whitelist**            | `cli/src/agent/tool-host/policy.ts:89` _"A non-empty allowlist is exhaustive — anything unlisted is out."_                                                                               |

A character configured `allowedTools: ["Read","Grep"]` gets two tools on OpenAI/Gemini and the
**entire** surface on Claude. The repo's own comment (`ai-sdk-tools.mjs:122`) calls the field
"a character/skill/mode tool whitelist", so the misreading is internal, not just latent.

Two consequences:

- The allow-mode tool filter draws from `lib/tools/tool-catalog.ts`, whose four sources exclude
  SDK-native tools — `Bash`, `Read`, `Task`, `EnterWorktree`, `TaskStop` are absent from an
  inventory the UI presents as complete (`build-options.ts:2057-2071`).
- `SDK_CORE_TOOL_NAMES` (`lib/skills/recording/tool-catalog.ts:23-34`) lists 11 names.
  `intersectAllowedTools` (`:54-71`) partitions a generated skill's tools and
  `generate-skill.ts:104-110` saves only `kept` — so `ReadMcpResource` is silently stripped
  from the artifact and reported to the user as non-existent, though the SDK ships it.

### SEC-6 — Restricted Mode and the IM ceiling deny 5 of 28 mutating tools

`RESTRICTED_MODE_DENIED_TOOLS` (`lib/workspace/restricted-tools.ts:7-24`) and the IM literal
(`lib/claude/build-options.ts:2878-2887`) are two hand-maintained lists covering the same five
logical tools. Missing from both: `apply_patch`, `Monitor`, `kill_shell`, all seven `file-ops`
mutators, `git_stage`, `git_commit`, `start_process`, `terminate_process`,
`shell_execute_advanced`, all three `terminal_repl_*`, `ast_grep_replace`, `clone_dep_source`,
both `web_clone*`, and `get_env`/`list_env`.

An inbound Telegram/Slack/Discord/Lark message therefore reaches `directory_delete`,
`shell_execute_advanced`, and `terminal_repl_spawn` — an unconfined PTY.
`lib/connectors/im-permission-ceiling.ts:25-58` is orthogonal: it denies skills, computer-use,
OCR, and scheduler tools only.

**The correct list already exists and is unplugged.** `CORE_MUTATING_TOOL_NAMES`
(`sidecar/builtin-tools/core/core-tools.mjs:55-63`) is documented as "restricted mode / IM
channels deny these" and _does_ include `apply_patch` and `Monitor` — but its only references
repo-wide are its own definition and its own test. Same for `isRestrictedTool`
(`restricted-tools.ts:33-38`), the one predicate that denies the whole
`mcp__cognia-plugin-tools__` prefix: referenced only by its own test, while
`build-options.ts:2899-2906` uses the raw array. Both are Working Rule 7 violations —
documented at the type, not enforced, not pinned as deliberately inert.

### SEC-7 — `kill_shell` is mis-tiered, and the metadata contradicts itself

`kill_shell` is `requiresApproval: false`; `terminate_process` is `true`. Both terminate a
process; they are in the same JSON file. The false value lands `kill_shell` in
`READ_ONLY_TOOL_NAMES`, which auto-allows it in plan mode, `dontAsk`, headless, restricted
mode, and IM sessions. An agent in a mode the UI labels read-only can kill the user's dev
server without a prompt.

`terminal_repl_read` has the same shape: `requiresApproval: false`, but `drain: true` is the
**default** and clears the ring buffer (`terminal-repl-tool.mjs:277-280`) — its own description
says "Destructive by default".

### SEC-8 — The Anthropic rail has no plan-mode enforcement for plugin/host tools

`grep -n '"plan"' sidecar/dispatch/anthropic.mjs` returns nothing. `canUseTool` (`:467-545`)
delegates plan mode wholesale to the SDK, which understands its own native tools and knows
nothing about `mcp__cognia-plugin-tools__*`. In plan mode on Claude, every plugin tool is
reachable: all 23 `browser_*` (including `browser_evaluate`, `browser_fill_form`), the 7
computer-use tools including `perform_action`, `terminal_dock_write`, `ocr.extract`,
`manage_scheduled_task`. The AI-SDK rail throws for all of them at `ai-sdk-tools.mjs:268`.

The divergence runs both ways: Anthropic is far too permissive, and AI-SDK is bluntly
restrictive — genuinely read-only tools (`browser_snapshot`, `clipboard_history_list`,
`terminal_dock_read_recent`) are denied there for no safety reason.

### SEC-9 — The CLI "mirror" is a second, differently-wrong implementation

`cli/src/agent/tool-host/policy.ts:18-22` declares itself a mirror of `confinement.mjs`.
Neither is a superset of the other.

|                        | sidecar `confinement.mjs`               | cli `policy.ts`                                                                  |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| tools in scope         | 18 names; everything else `null`        | **every** tool                                                                   |
| path keys              | 3                                       | 16 + recursion into `edits`/`files`/`operations`                                 |
| `workdir`              | ✅                                      | ❌                                                                               |
| symlink resolution     | ✅ `realpathSync.native`                | ❌ purely lexical                                                                |
| case folding           | Windows only                            | ❌ none                                                                          |
| path splitting         | `/[\\/]+/`                              | `path.sep` only — a `/`-separated Windows path yields one segment and fails open |
| out-of-root read       | allow                                   | hard deny                                                                        |
| secret dirs only here  | `.gpg`, `.config/gcloud`, `.config/gh`  | `.cognia`, `.npmrc`                                                              |
| secret files only here | `.git-credentials`, `_netrc`, `.pypirc` | `.pgpass`, `id_rsa`, `id_ed25519`, `known_hosts`                                 |

Neither covers `oldPath`/`newPath`, `pathA`/`pathB`, `output`, `paths[]`, `globs[]`,
`apply_patch`'s embedded paths, or any shell **command text**. `~/.config/gh/hosts.yml`
(GitHub OAuth token) is unprotected on the CLI rail.

### SEC-10 — `bash` has no allowlist, which makes subsystem blacklists decorative

`BLOCKED_COMMANDS` / `ALLOWED_COMMANDS` (`sidecar/builtin-tools/safety.mjs:112,167`) are
enforced only by `validateShellCommand` (`:469`), whose sole callers are
`shell-advanced.mjs:53` and `process/inventory.mjs:228`. `core/bash.mjs` references none of
them — verified. `bash` is classified by confinement but only via `workdir`; the `command`
string is never parsed, so `bash({command:"cat ~/.ssh/id_rsa"})` yields no targets and no verdict.

Consequence for the never-reachable blacklist agreed for this audit — subscription/payment,
backup-restore, keyring, permission settings: all four are protected only by the _absence of a
typed tool_, and `bash` walks around all of them (`security find-generic-password` is in
neither the blocked nor allowed list). Additionally, `node`, `python`, `deno`, `bun`, `ruby`
are all in `ALLOWED_COMMANDS`, so even the allowlisted `shell_execute_advanced` path grants
arbitrary code execution.

Also: `confinement.mjs:37-54` protects `.ssh`, `.aws`, `.gnupg` and friends but **not**
`<app_data>/cognia/`, where `vectors.sqlite`, the settings store, backup archives, and the
subscription projection live — and the documented policy is that a read outside the roots is
allowed without even an "ask".

### SEC-11 — `SlashCommand` is an ungated privilege bridge

`runSlashCommandBuiltinTool` (`lib/claude/slash-builtin-tools.ts:104`) dispatches any
registered command through the live registry with no host-side approval. Its docstring
(`:7-14`) claims built-in UI commands only return guidance; `/remember` has a real handler that
performs a memory write (`lib/slash-commands/actions/remember.ts:38`), and
`lib/slash-commands/actions/` also contains `billing.ts`. The manifest enumerates up to 60
commands to the model (`:57-62`). Any blacklist enforced at the tool layer is bypassed here.

### SEC-12 — The external-agent bridge performs no input validation

`sidecar/cognia-tool-bridge.mjs:237` calls `def.handler(args ?? {}, {})` on raw JSON-RPC
arguments; the zod shape is used only to _generate_ the advertised schema (`:227`). No type
validation and **no `.default()` application** for any of the 42 file/git/process/env tools.
Concrete effects: `content_search`'s `maxResults` cap disappears entirely (`length >= undefined`
is always false), `shell_execute_advanced` runs with **no timeout**, `start_process` gets a
`NaN` timeout, `terminal_repl_read` returns an empty string. Separately, `:121-123` catches any
schema-conversion failure and advertises the tool as **taking no parameters**.

---

## 5. P0 — the system lies to the model

### P0-1 — `bash` reports spawn failures as successful output _(empirically verified)_

`core/bash.mjs:324-328` handles `child.on("error")` by appending the message to the output and
calling `finish({code: null})`; `:353` computes `failed = timedOut || (code !== 0 && code !== null)`,
so `null` is never a failure and `:354` returns `toolText(body)` with no `isError`. Executing a
missing shell binary returns `{"content":[{"type":"text","text":"spawn /nonexistent ENOENT"}]}`
with `isError: undefined`. The model reads an ENOENT as ordinary command output.

### P0-2 — Schema fidelity is rail-dependent

`jsonSchemaPropToZod` (`sidecar/builtin-tools/plugin-tools.mjs:216-257`) reads only `type`,
`items`, `description`, and top-level `required`. It **silently drops** `enum`, `const`,
`default`, `format`, `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`,
`minItems`/`maxItems`, `uniqueItems`, `additionalProperties`, `oneOf`/`anyOf`/`allOf`,
`$ref`/`$defs`, **nested `properties`**, and **nested `required`**. `case "object"` (`:243-245`)
collapses any nested object to `z.record(z.string(), z.unknown())`. The AI-SDK rail passes the
raw manifest through `jsonSchema()` (`ai-sdk-tools.mjs:717`) with full fidelity.

Worst three:

- **`dispatch_agent`** — the `subagentId` enum _is_ the discovery mechanism
  (`lib/claude/agents/dispatch-agent-tool.ts:92`, commented as such). On Anthropic it becomes a
  bare optional string, `dispatches` becomes an array of opaque records, and
  `parseDispatchAgentArgs` **silently drops** invalid items (`:216-217`) — a fan-out can quietly
  shrink.
- **`working_set`** — loses a 4-value `action` enum and the entire `entry` sub-schema (3 enums,
  `required`, `summary` 1–512, `refs.maxItems:4`). Re-validated downstream, so this costs
  retries rather than correctness.
- **`terminal_dock_*`** — lose `additionalProperties:false`, `type:"integer"`, and every bound;
  the handler responds to an out-of-range value with a **silent fallback to the default**
  (`lib/terminal/dock-tool-handler.ts:106-112`, `:200-203`), so the model never learns its bound
  was ignored.

### P0-3 — Host-routed tools cannot return a tool error

Every branch in `lib/claude/plugin-tool-ipc.ts:478-566` returns `{...baseResponse, result}`.
The only paths to a real `tool-error` are `ai-sdk-tools.mjs:733` and `plugin-tools.mjs:160-162`,
both keyed on `response.error`, which those branches never set. A failed `web_search`, `Skill`,
`SlashCommand`, `team_*`, `vector_*`, `session_*`, `spawn_task`, `read_active_editor` or
`working_set` reaches the model as a **successful** result whose payload happens to say
`ok:false` or begins with the literal `"Error: "`.

### P0-4 — Advertised-but-dead tools on the external-agent bridge

`sidecar/cognia-tool-bridge.mjs:199-212` passes neither `hostRpc` nor `sessionId`, so
`Monitor`, `monitor_cancel`, `monitor_list` always return
`"monitors are not available in this session"` (`core/monitor.mjs:157-159`, `:231`, `:253`) —
while still appearing in the bridge's `tools/list`, because `visibleBuiltinTools`
(`cli/src/agent/tool-host/policy.ts:79-98`) has no notion of runtime availability.

### P0-5 — The headless CLI treats a channel object as a capability

`agent-host.mjs:124` creates `hostRpc` unconditionally; `ai-sdk.mjs:556-558` and
`anthropic.mjs:238-240` then branch on its **truthiness** to choose the host-backed shell
registry. `createHostRpc` (`sidecar/host-rpc.mjs:29-61`) has no handshake and cannot tell
whether anyone is listening. `grep -rn "host_rpc" cli/src/` returns nothing — the CLI never
answers those frames. So under the packaged CLI every `bash(run_in_background)`,
`bash_output`, `kill_shell`, `list_shells` and monitor call **stalls 30 s and fails**, while the
working in-process `createBgShellRegistry()` sits unreachable as dead code. Contrast the Rust
side, which degrades explicitly (`src-tauri/src/jobs/mod.rs:82,87`).

### P0-6 — `lsp`/`codeGraph` vanish silently with the settings toggle still on

`sidecar/builtin-tools/index.mjs:169` and `:174` guard registration with `flag && resolver`,
while `namesForDisabledCategories` (`:284-296`) guards the denylist with `!flag` alone. When
`flag === true` and `resolver === null`, neither branch covers the 14 names: they are **neither
registered nor denied**. Since `disallowedTools` is the documented defence-in-depth
(`anthropic.mjs:327-333`), a stale `Character.allowedTools` entry or a hallucinated
`mcp__cognia-tools__lsp_hover` is neither served nor rejected at the SDK boundary.

The state is easy to reach for LSP: `opts.lsp` is populated only when
`(appSettings.lsp?.enabled ?? appSettings.builtinTools?.lsp) && !supportAgent && opts.cwd`
(`lib/claude/build-options.ts:2191-2192`), so `builtinTools.lsp === true` with
`settings.lsp.enabled === false`, **or** a support-agent session, **or** any session without a
`cwd`, all land in the gap. For codeGraph only a missing `cwd` does.

The settings UI gives no signal: `components/settings/tools/tool-settings-section.tsx:99` reads
static JSON plus the persisted toggle, renders the category ON with all tool badges, and has no
runtime-availability probe. `lib/tools/tool-catalog.ts:98-117` likewise marks every built-in
`enabled: true` unconditionally.

Related: `lsp_diagnostics` cannot distinguish "host unavailable" from "file is clean".
`sidecar/dispatch/lsp-resolver-factory.mjs:49` throws when the resolver is null, but `:53`
returns `[]`, which `lsp.mjs:167-171` renders as `"No diagnostics."` The other four `lsp_*`
tools correctly surface `toolError`.

### P0-7 — Phantom parameters and descriptions that promise unimplemented behaviour

- **`bash_output.from_offset`** — the description (`core/bash.mjs:88-91`) states _"Reads never
  consume, so an earlier range can always be re-read."_ On the in-process registry
  `bash-sessions.mjs:124` destructures only `{filter, maxChars}` and `:130` advances the cursor.
  The parameter is phantom **and** the read consumes. This is the registry used by the bridge
  and by any session without `hostRpc`.
- **`bash.detach`** — documented "Requires run_in_background", never validated; and
  `bash-sessions.mjs:50` never reads it, so a "detached" shell is still reaped by `killAll()`,
  contradicting "keep running after this chat session ends".
- **`apply_patch`** — claims "every file is written only if all hunks apply cleanly; otherwise
  nothing is written" (`:32-33`, `:244`). Atomicity holds for hunk _matching_ only; the commit
  phase (`:208-226`) has no try/catch, so a failure on file _N_ throws raw with files 1..N-1
  already on disk.
- **`team_delegate`** reads `systemPrompt` (`lib/claude/team-builtin-tools.ts:818`) which is
  **not declared in its schema** at all — an undeclared parameter.
- **`load_skill_resource`** — `offset.minimum:0` and `limit.minimum:1/maximum:65536` are
  phantom; the handler does a bare `typeof === "number"` check (`skill-builtin-tools.ts:178-179`).
- Enums declared and never enforced: `team_request_consensus.type`, `team_propose_decision.impacts`,
  `vector_search.filters[].operation`, `web_fetch.format`, `load_skill.skill_id`.
- **`file_delete` does not exist.** `safety.mjs:478` tells the model _"Use the file_delete /
  directory_delete / process tools"_ whenever a command is blocked. No such tool exists anywhere
  in the repo — the error steers the model to a nonexistent tool.

### P0-8 — `ast_grep_replace` rewrites files in the wrong directory

`runSg` spawns with `cwd: opts.cwd` (`sidecar/builtin-tools/ast-grep/run.mjs:166`), but both
`execAstGrepSearch` and `execAstGrepReplace` call it with a **single argument**
(`ast-grep/index.mjs:49`, `:103`), so `opts = {}` and `cwd` is `undefined`. The child therefore
inherits the **sidecar process's** cwd, not `sendOptions.cwd`. The schema's documented default
`paths: ['.']` (`index.mjs:32`, resolved at `run.mjs:57`) resolves against wherever Tauri or the
CLI launched the sidecar. `ast_grep_search` returns confusing empty results; `ast_grep_replace`
with `dry_run:false` **writes to an unrelated tree**.

This compounds with the confinement gap: `ast_grep_replace` is in none of the confinement sets,
calls neither `assertPathInside` nor `assertNotSecretEscape`, and is authorized by the approval
prompt alone. Its two sibling mutators are better behaved — `web_clone`/`web_clone_convert`
self-confine (`webclone/run.mjs:102,136`) and `clone_dep_source` confines to a resolved git root.

### P0-9 — A truncated `ast-grep` rewrite is reported as a clean success

`ast-grep/run.mjs:224-235` — the output-size branch kills the child and returns
`{...parsed, truncated:true, truncatedReason:"output size"}` with **no `error` field**, so
`index.mjs:113` takes the `toolText` arm and `format.mjs:76` renders
`[APPLIED] changed N matches in M files` with `isError` unset. A `--update-all` rewrite that was
**SIGKILLed mid-write** reaches the model as a completed operation.

Adjacent: `run.mjs:106` discards a JSON _object_ from ast-grep (its error payload shape) via
`if (!Array.isArray(parsed)) return { matches: [], totalMatches: 0 }`, rendering
`"No matches found."` — indistinguishable from a genuine zero-result search.

### P0-10 — All five A2UI tools report success unconditionally

`dispatch` is `emit({type:"a2ui_dispatch", …})` (`sidecar/a2ui-tools/index.mjs:69-71`) — a
fire-and-forget stdout write with no acknowledgement. Every handler returns
`{ok:true, dispatched:true}`; the `try/catch` fires only if `emit` itself throws. So
`a2ui_update_components`, `a2ui_data_model_update`, `a2ui_delete_surface` and
`a2ui_handle_connector_action` all report success against a **nonexistent `surfaceId`**, a
disconnected renderer, or a torn-down window. `dispatched: true` means "written to stdout" and
nothing more — the model cannot tell whether the user ever saw the surface.

### P0-11 — `codegraph_impact` reports a blast-radius number it knows is wrong

The comment at `sidecar/builtin-tools/code/tools.mjs:207-209` states `impactCount` "always
reflects the TRUE blast-radius size". `code/graph.mjs:46` returns early at `MAX_RESULTS = 500`
(`:16`) with no flag, so on any graph large enough to matter the number is silently a floor, not
a total — and impact analysis is exactly the tool an agent uses to decide whether a change is
safe. The co-located test uses a tiny graph and never trips the cap.

Related, same file: `codegraph_status` is described as _"Cheap — call first"_, while `run()`
(`tools.mjs:87`) awaits `syncStale()` → `ensureIndexed()` → a full-repo tree-sitter build.

### P0-12 — `Task` is handled but never advertised

`buildDispatchAgentManifestEntry` emits only `dispatch_agent`
(`lib/claude/agents/dispatch-agent-tool.ts:153`). `Task` is accepted as an alias at
`plugin-tool-ipc.ts:653` and appears in `NEVER_PRUNE_TOOLS` (`build-options.ts:821`) and
`PLAN_ALLOWED_PLUGIN_TOOLS` (`ai-sdk-tools.mjs:57`) — pruning protection and a plan-mode
allowance for a name no manifest ever contains.

### P0-13 — Process tracking is structurally broken

`start_process`'s supervisor path (`process/lifecycle.mjs:60-75`) returns without calling
`trackedPids.add`; only the fallback path (`:78-87`) populates it — and the fallback is
**unreachable in every production wiring**, since `index.mjs:164` always supplies `bgShells`.
Therefore `get_tracked_processes` always returns empty, `get_process_manager_status` reports
`{enabled: true, trackedCount: 0}` for a registry that cannot be non-empty, and
`terminate_process` refuses pids that `start_process` spawned seconds earlier with
_"pid N was not started by this session"_. On the bridge it is worse: `createBgShellRegistry`
exports no `killByPid` (`bash-sessions.mjs:209`), so `terminate_process` refuses **every** pid,
and `start_process` returns `pid: null` anyway. `trackedPids` is also module-level state shared
across all concurrent sessions (`process/inventory.mjs:17`) despite every message saying "this session".

---

## 6. P1 — works, but not robust

### P1-1 — No built-in tool honours an `AbortSignal`

Systemic. `ai-sdk-tools.mjs:101` calls `def.handler(effective, {})` with a literal empty object;
`options.abortSignal` is read only to bound the permission gate (`:659`, `:720`).
`plugin-tools.mjs:141` takes no `extra` at all, and the bridge does the same
(`cognia-tool-bridge.mjs:237`). Two modules are plumbed for a signal and never receive one:
`core/rg.mjs:157,168` and `ast-grep/run.mjs:135,167`.

Consequences: a user interrupt cannot stop an in-flight `bash`, a `Monitor` long-poll
(up to 24 h, `core/monitor.mjs:29`), a multi-minute `grep`, or a PDF extraction. The 120 s
read-only net (`read-only-timeout.mjs`) _abandons_ the handler rather than cancelling it — it
explicitly detaches the orphan at `:84-87`. `web` and `vector` both declare a `signal`
dependency that the production resolvers never populate.

An internal inconsistency worth noting: `read-only-timeout.mjs:70-77` deliberately keeps its
timer REF'd, with a comment explaining that an unref'd timer let the loop drain mid-wait —
while `plugin-tools.mjs:84` unrefs its own.

### P1-2 — At least five incompatible result shapes

| Shape                         | Examples                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{ok, code?, error?}`         | `web-builtin-tools.ts:124`, `working-set-tool.ts:80-160`, `vector-builtin-tools.ts:229`                      |
| `{available, reason?/error?}` | `editor-builtin-tools.ts:96,101,115` — and it uses `error` and `reason` inconsistently within the same union |
| raw string                    | `slash-builtin-tools.ts:100-115`, most of `team-builtin-tools.ts`                                            |
| `{ok, reason}`                | all four `terminal_dock_*` (`dock-tool-handler.ts`) — `reason`, not `error`                                  |
| bare array / bare object      | `team_read_memory`, `team_list_members`, `task_get`, `team_propose_decision`, `twin_knowledge_search`        |

`skill-builtin-tools.ts` and `team-builtin-tools.ts` each use more than one shape internally.
`web_fetch` overloads `ok` as the HTTP status flag, so a 404 yields `ok:false` with **no
`error` field** (`web-tools-core.ts:445`).

### P1-3 — `timeoutMs: 0` removes the only recovery path for two tools

`ask_user` and `dispatch_agent` ship `timeoutMs: 0` (`ask-user-tool.ts:84`,
`dispatch-agent-tool.ts:161`), which makes `awaitPluginToolResponse` create no timer at all
(`plugin-tools.mjs:70-93`), disabling the 120 s safety net. The AI-SDK rail resolves pending
calls on interrupt (`ai-sdk.mjs:1580-1583`); the Anthropic rail needs `drainPendingRoundTrips`
(`anthropic.mjs:120-154`) because `Query.interrupt()` does not touch them.

But the drain settles only the _sidecar's_ promise. Nothing propagates to the renderer:
`plugin-tool-ipc.ts:643-647` never forwards `abortSignal` to `runAskUser`, and
`stores/agent/ask-user-store.ts` has no cancel path — **the modal stays on screen after the
turn is killed**, and the eventual answer is dropped silently because its `toolUseId` is gone.
In CLI headless (`cognia run`) `ask_user` is manifested with no responder at all, so the turn
blocks forever.

### P1-4 — Plan-mode allowlists and the `ask_user` divergence

`PLAN_ALLOWED_PLUGIN_TOOLS` (`ai-sdk-tools.mjs:57`) has 3 names; `PLAN_ALLOWED_HOST_TOOLS`
(`policy.ts:58-63`) has 4, adding `ask_user`. In practice they are equivalent because
`ask_user` is short-circuited before the mode read (`ai-sdk-tools.mjs:210-214`). The two lists
should still be a single shared constant — the divergence is latent, not active. The real
plan-mode gap is SEC-8.

### P1-5 — Swallowed errors that read as clean results

- `diagnosticsAfterWrite` returns `""` on any LSP failure (`core/write.mjs:47-49`), so
  `edit`/`write`/`apply_patch` render "clean" identically to "LSP crashed".
- `list_shells` returns `[]` on any `jobs.list` RPC failure (`bash-host-sessions.mjs:200-207`) —
  a 30 s timeout reads as "no shells".
- `statOrNull` (`shared/fs-stat.mjs:14-20`) swallows everything, so `file_exists` reports
  `EACCES` as `{exists:false}`.
- `file_search`/`content_search` pass `suppressErrors: true`, so a permission-denied subtree is
  invisible and a partial walk is reported with `truncated: false`.
- `git_repo_inspect` has three `.catch(() => null)` legs, so detached HEAD, unborn branch, no
  upstream and a crashed `git` all produce `null` in a success envelope.
- `detectRipgrep` returning `null` is unobservable (`core/rg.mjs:51-58`) — a 5 s PATH-probe
  timeout is identical to "rg is not installed", and the JS fallback then applies different
  gitignore fidelity and different caps with no note.
- `git_stage` echoes `staged: args.paths` unconditionally, even when `git add` staged nothing.
- `directory_create` returns `{created: true}` for an existing directory.

### P1-6 — Undeclared caps, truncations and timeouts

None of these are mentioned in any `.describe()` reaching the model. A representative set:
`grep` clips lines at 1000 chars and the JS fallback caps at 2000 matches / 50 000 files /
4 MB per file; `read` caps at 2000 chars per line, 256 KB output, 50 PDF pages, 5 MB images;
`content_search` skips files over 5 MB **silently** and hard-excludes all dotfiles via
`dot:false` — which the `respectGitignore` parameter actively misleads about; gitignore
negation (`!pattern`) is silently dropped (`core/gitignore.mjs:45`); the git tools share a
30 s timeout and a 16 MB capture ceiling, and **only `git_diff` applies the 256 KB display
cap**; process snapshots may be 1.5 s stale with no marker; `terminal_repl` kills an idle
session after 10 minutes and the next read reports `{exited:true, exitCode:null}`,
indistinguishable from a crash.

Two that are worse than undeclared:

- **`rg` timeout resolves as success.** `core/rg.mjs:175-208` kills the child at 30 s, then
  resolves `{stdout: <partial>, code: 0, truncated: false}` — `grep` presents a partial scan as
  a complete result.
- **`edit`'s fuzzy matcher** uses `BLOCK_ANCHOR_THRESHOLD = 0.65`
  (`core/fuzzy-replace.mjs:15`) — it will replace a block only 65% similar to `old_string`,
  while the description says merely "whitespace-tolerant strategies".

### P1-7 — Identical messages for distinct failures

`"file not found"` covers ENOENT, EACCES, ELOOP and ENOTDIR across `read`, `edit`,
`notebook-edit`, `apply_patch`, `file_hash`, `file_diff`. `apply_patch` reports "no hunk
matched" and "hunk matched ambiguously" identically, though only one of the two is fixable by
its advice. `"pid N was not started by this session"` fires both for a foreign pid and for one
this session just spawned. The git catch-all advises "restart the sidecar" for what is usually
`git` missing from PATH (`git/run.mjs:68-71`).

---

## 7. P2 — hygiene

### P2-0 — 17 co-located sidecar test files never run in CI

`.github/workflows/test.yml` runs `pnpm sidecars:test` → `sidecar:test` →
`sidecar:test:builtin`, whose glob covers `__tests__/`, `shared/`, `core/`, `file-ops/`,
`process/`, `git/`, `code/`, `code/languages/` — and **not** `builtin-tools/*.test.mjs` (top
level), `ast-grep/`, `clonedeps/`, `webclone/`, or `a2ui-tools/`. Jest excludes `/sidecar/`
entirely (`jest.config.ts:123`).

Orphaned: `confinement.test.mjs`, `exit-plan.test.mjs`, `index.test.mjs`,
`plugin-tools.test.mjs`, `result-cap.test.mjs`, 5 files under `ast-grep/`, 4 under
`clonedeps/`, 2 under `webclone/`, and `a2ui-tools/tool-defs.test.mjs`. Executed directly:
**137 tests, 137 pass**. They are not broken — they simply gate nothing, so the tools they
cover (`ast_grep_*`, `clone_dep_source`, `web_clone*`) have real tests with zero regression
protection, and `confinement.test.mjs` pins the classification logic behind SEC-1/SEC-2 without
ever running.

`sidecar/package.json:14` has a **different, disjoint** glob that does cover those directories
but omits `__tests__/` — and nothing invokes it, since the root scripts call
`sidecar:test:builtin` rather than `pnpm --dir sidecar test`. Two globs, neither complete.

**Fix:** make one glob authoritative and add a check that every `*.test.mjs` under `sidecar/` is
matched by it.

### P2-1 — Other hygiene

- **A missing `webclone/dist/` takes down the entire tool server.**
  `sidecar/builtin-tools/webclone/run.mjs:19-25` statically imports `../../webclone/dist/index.js`,
  which is gitignored (`.gitignore:158`) and produced only by `prebuild`. Because
  `builtin-tools/index.mjs:24` imports the webclone category at top level — unlike ast-grep's lazy
  binary probe or terminalRepl's lazy `node-pty` require — a missing `dist/` fails **all 83
  built-ins**, not just the two webclone tools.
- **Missing co-located tests**: `sidecar/builtin-tools/core/todo.mjs` (the only `core/` tool
  without one), `sidecar/a2ui-tools/index.mjs`, `sidecar/dispatch/anthropic.mjs` (700+ lines
  including the whole `canUseTool` gate), `sidecar/dispatch/lsp-resolver-factory.mjs`,
  `code/store*.mjs`, the four `code/languages/*.mjs`. In `lib/`:
  `lib/claude/computer-use-active-settings.ts`, `lib/claude/chat-middleware/feature-flag.ts`,
  six files under `lib/claude/agents/subagents/`. Family B is clean: 16/16 present.
- **Non-co-located sidecar tests**: `environment.mjs`, `shell-advanced.mjs`,
  `terminal-repl-tool.mjs` are tested from `__tests__/` rather than beside the source.
- **A2UI is absent from every catalog and every policy.** `lib/tools/tool-catalog.ts` aggregates
  four sources and A2UI is none of them; it is also absent from `builtin-tools-data.json`
  entirely, so its 5 tools carry **no `requiresApproval` or `riskLevel` anywhere**, are excluded
  from `READ_ONLY_TOOL_NAMES` and `namesForDisabledCategories`, and cannot be seen, filtered, or
  scoped via `allowedTools`. They register only on the Anthropic rail (`anthropic.mjs:287`) —
  zero hits in `ai-sdk-tools.mjs` — so OpenAI/Gemini/local sessions have no interactive surface
  and can only fall back to fenced ` ```a2ui ` blocks. Their `alwaysLoad: true` is passed as a
  literal at the call site rather than via `serverAlwaysLoad()` as the builtin and user servers
  do (`anthropic.mjs:247`, `:270`), so they sit in the cached prompt prefix even when the user
  enabled tool search specifically to shrink it. The docstring at
  `sidecar/a2ui-tools/index.mjs:4` and `:62` says "four bridge tools"; there are five — the count
  predates `a2ui_handle_connector_action`, and the sibling `a2ui-mcp.mjs:5-7` gets it right.
- **Registration-order gates are missing for `fileExtras`, `git`, `process`.** Only
  `CORE_TOOL_NAMES` has a real one. `FILE_EXTRAS_TOOL_NAMES` (`file-ops/index.mjs:37-51`)
  already disagrees with the JSON's order, and both files cite prompt-cache prefix stability as
  the reason order matters.
- **`desktopOnly` is a dead flag.** Declared in `lib/settings/builtin-tools.ts:50` and set on
  `coreFiles`, read by nothing. Working Rule 7: at the type, not in the UI, not pinned.
- **Dead bindings**: `taskStatusSchema` (`core/tasks.mjs:22`) is never referenced — the real
  enum is inlined at `:44`. `TaskList` (`:276`) is the only task tool without a try/catch.
  `codeGraphResolver` is missing from the JSDoc on `collectCogniaToolDefs` (`index.mjs:134-141`).
- **The bridge never disposes.** `lsp-resolver-factory.mjs:6-7` and
  `codegraph-resolver-factory.mjs:6` both state callers MUST call `dispose()`;
  `anthropic.mjs:827` and `ai-sdk.mjs:1674` comply, `cognia-tool-bridge.mjs` does not — spawned
  language servers, the SQLite store and the fs watcher live for the process lifetime.
- **9 missing i18n keys.** `builtin-tools-data.json` declares 83 `descriptionKey`s; only 74
  exist. Missing in **both** locales, in both the split sources and the monolith:
  `toolSettings.tools.codegraph{Status,Search,Node,Callers,Callees,Impact,Context,Explore,Files}`.
  Consumed at `components/settings/tools/tool-settings-section.tsx:385` via
  `t(tool.descriptionKey)` — a dynamic reference, which is exactly what `lint:i18n` skips. With
  no `getMessageFallback` override configured, the panel renders the literal key path and logs
  an `IntlError`; it does not crash.

---

## 8. Subsystem reachability

Denominator: the Subsystem Map in `CLAUDE.md`. Full per-row table omitted here for length;
the conclusions follow.

### The governing finding: reachability is inverted

`lib/external-bridge/mcp-server/server.ts` exposes ~30 rich tools — `memory_search`,
`memory_store`, `rag_search`, `wiki_search`, `schedule_task`, `connectors_*`, `runtime_query`,
`workflow_*` — to **external** MCP clients. `build-options.ts:2157,2161` builds `opts.mcpServers`
solely from user-configured servers and never from the self-bridge. **A third-party Claude Code
instance connected over the bridge is strictly more capable inside cognia than cognia's own
agent.** Most of the list below closes by wiring a permission-scoped in-process client to the
server that already exists.

**No reachability at all**, ranked by cost: long-term memory (0069) · content capture (0060) ·
native video processing (`crates/cognia-media`, a whole crate with a plugin API and no consumer) ·
Attention Radar (0060) · optical compaction (0063) · public share links (0037) ·
platform connectors (0009) · wiki lint (0060) · then session anchors/permalinks (0094),
voice/TTS (0075), perf dashboard (0035), desktop selection awareness (0095), marketplace
integrations (0026), plugin Dexie tables, WebRTC transport (0021), mobile sync (0027),
CLI↔app bridge (0078), desktop pet (0058), risk→ceremony policy (0070), and the External
Bridge itself (0008).

**Readable but not writable, where writing is obviously useful**: Pro IDE (`read_active_editor`
exists; no `reveal_in_editor`/`open_diff`) · skill recorder (`record_skill_status` reads; no
start/stop/replay) · digital twin (`twin_knowledge_search` reads, team sessions only; no ingest) ·
OCR (extraction works; stored results in `lib/db/ocr-results.ts` are unreadable, forcing
redundant re-OCR) · SCM (the 11 `git_*` tools wrap the git CLI, not `crates/cognia-git`, so the
agent cannot see the panel's staged state) · `/goal` (injected read-only; no way to record progress).

**Fragile — reachable only via a plugin the user can disable**: the scheduler is the sharpest
(`plugins/cognia-scheduler-tools` is the _sole_ path), then visual workflows (only
`wf_run_workflow_typed` survives), computer use, embedded browser, OCR, workspace backends.
Five plugin API surfaces — `integrations`, `templates`, `media`, `perf`, `memory` — have **no
consumer at all**: the seam is built, the plug was never inserted.

### The never-reachable blacklist is not currently enforceable

Subscription/payment, backup-restore, keyring, and the permission settings surface have no
typed tool, which is correct — but SEC-10 shows `bash` reaches all four anyway, and SEC-11
shows `SlashCommand` walks around any tool-layer list. A blacklist is only meaningful if it is
enforced where the reach actually happens: in `isSecretPath`, in `bash`'s own command handling,
and in the slash registry's dispatch path.

---

## 9. Implementation chapter

### 9.1 Six of the nine "absent" tools already ship natively

`sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` declares
`EnterWorktreeInput` (:2922), `ExitWorktreeInput` (:2932), `TaskStopInput` (:704),
`ListMcpResourcesInput` (:714), `ReadMcpResourceInput` (:761), `ReadMcpResourceDirInput` (:751).
Cognia references none of them. Static tracing of every filter — `enforceAnthropicToolSurface`,
`allowedTools` forwarding, the three `disallowedTools` sources, `namesForDisabledCategories`,
`buildMcpDisallowedToolNames` — found nothing that drops them, so they should be reachable on
the Anthropic rail in a default session today. **This is a static conclusion and is the first
thing to verify empirically.**

Therefore the work is not "build nine tools". It is:

1. Verify Anthropic-rail reachability in a live session.
2. Fix `SDK_CORE_TOOL_NAMES` (`lib/skills/recording/tool-catalog.ts:23-34`) and add SDK-native
   tools as a fifth source in `lib/tools/tool-catalog.ts`. Both are small and stop the
   misleading "unknown tool" reports and the incomplete filter inventory (SEC-5).
3. Only then build AI-SDK rail parity, in ascending cost order below.

### 9.2 Build order for AI-SDK rail parity

| Tool                             | Cost                    | What exists / what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskStop`                       | **lowest**              | `stopTask` exists end-to-end — allowlisted `sidecar/dispatch/control.mjs:34`, capability `tasks.background` `:71`, handle `agent-execution-handle.ts:137`, cancel registered per `task_started` in `sdk-subagent-bridge.ts:122`. Human-only today (`subagent-part.tsx:286`, `job-center-panel.tsx:509`). Needs a tool wrapper and a permission tier.                                                                                                                                                                                                                                                                      |
| `ListMcpResources`               | low–med                 | `listResources()` is already called (`mcp-runtime-gateway.mjs:69-84`) and its metadata is typed, transported, and then **discarded** — `components/settings/mcp/mcp-server-card.tsx` renders `toolCount` only. Needs live clients threaded out of `ai-sdk-mcp.mjs:385`.                                                                                                                                                                                                                                                                                                                                                   |
| `ReadMcpResource` / `…Dir`       | medium                  | Same plumbing, plus a **new URI-shaped permission gate**: `isMcpToolPermitted` (`ai-sdk-mcp.mjs:364`) filters by namespaced tool name and cannot express a resource URI. Note `readResource` is called **nowhere** in the repo today.                                                                                                                                                                                                                                                                                                                                                                                     |
| `ListPlugins` / `SearchPlugins`  | low                     | `wf_list_plugins` (`plugins/workflow-ai/src/tools/resource-tools.ts:185`) proves the read path; metadata is not sensitive; no scoping invariant. Cheapest of the four discovery tools.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ListSkills` / `SearchSkills`    | low, **policy-blocked** | `wf_list_skills` already returns the full unscoped table — but shipping it in chat breaks a deliberate invariant: `invocationPolicy: "explicit"` exclusion (`build-options.ts:1027-1031`) and `session.disabledSkillIds`, enforced at `lib/skills/runtime-loader.ts:76-78`. **Needs a product decision before implementation.**                                                                                                                                                                                                                                                                                           |
| `EnterWorktree` / `ExitWorktree` | **highest**             | `crates/cognia-git/src/worktree.rs` has all 11 operations, but only 5 have Tauri commands (`commands.rs:280-314`) — `add_managed`, `remove_managed`, `lock`, `unlock`, `create_branch_here` do not. Missing beyond that: sidecar-side allowed-roots registration (`registerDialogPathInRust` is renderer-only), a **mutable per-session `cwd`** (construction-time only, `index.mjs:150`), confinement re-scoping, `SessionExecutionContext` persistence, and additions to all three deny lists. `WorktreeCreate`/`WorktreeRemove`/`CwdChanged` already exist as hook events (`lib/claude/hooks/event-catalog.ts:67-71`). |

Note for `TaskStop` on the session task graph (as opposed to SDK background tasks): there is no
terminal status to stop _into_. `core/tasks.mjs:22` declares `pending`/`in_progress`/`completed`;
`"deleted"` (`:44`) erases rather than records. And `:203` treats any non-`completed` blocker as
blocking forever, so a stopped task would permanently wedge everything it blocks. Task state is
also in-memory with ids restarting at `"1"` per sidecar process (`:92-93`), so a persisted
transcript referencing task `"3"` can silently rebind to a different task after a restart.

### 9.3 Subsystem tools, under the agreed policy

Policy: read-only always reachable; writes tiered by side effect; subscription/payment,
backup-restore, keyring and the permission surface never reachable — **enforced per §8, not by
tool absence.**

Highest value first, all read-only and therefore ungated: `memory_search`/`memory_list`,
`capture_list`/`capture_get`, `radar_read`, `optical_archive_read`, `share_links_list`,
`ocr_results_query`, `wiki_lint_read`, `connectors_inbox_read`. Each already has a working
implementation on the External Bridge or in a Dexie table; the work is exposure, not logic.
Write-side candidates worth tiering: `goal_record_progress`, `twin_ingest`,
`skill_recording_start/stop`, `reveal_in_editor`.

---

## 10. Gate changes — make the class of defect impossible

Fixing the individual findings without these leaves the same defects free to reappear.

1. **Extend the parity test beyond tautology** (`sidecar/builtin-tools/__tests__/metadata-parity.test.mjs`):
   - assert every `descriptionKey` resolves in **both** locales (catches §7's 9 keys);
   - assert every `requiresApproval: true` tool is classified in `confinement.mjs`;
   - add a declared side-effect field to the metadata and assert `requiresApproval` is derived
     from it, so `kill_shell` cannot disagree with `terminate_process`;
   - add registration-order gates for `fileExtras`, `git`, `process`.
2. **Derive the deny lists from data.** Replace `RESTRICTED_MODE_DENIED_TOOLS` and the IM
   literal with one computed set — every `requiresApproval: true` tool plus `kill_shell`,
   `terminate_process`, `get_env`, `list_env` — emitted in both bare and namespaced forms, with
   a test that fails when a new mutating tool is not covered. Wire `CORE_MUTATING_TOOL_NAMES`
   and `isRestrictedTool` in rather than leaving them dormant.
3. **Give Family B a manifest.** Mirror `builtin-tools-data.json`: name, risk, approval tier,
   shell availability, plus a parity test binding it to the `is*BuiltinTool()` cascade. Today
   adding a host-routed tool requires editing three files with no compile-time link, and the
   cascade's precedence is already inconsistent — `web_*`/`Skill`/`working_set`/`vector_*`
   shadow plugins, while `ask_user`/`dispatch_agent`/`Task`/`terminal_dock_*` are shadowed _by_
   them (`plugin-tool-ipc.ts:478-661`).
4. **Extract the path policy into a shared zero-`@/` package.** The sidecar and CLI can keep
   separate enforcement points — that constraint is about not trusting the confined process —
   while sharing the _data_. Add a test asserting the two runtime sets are equal.
5. **Forward the `AbortSignal`.** One change at `ai-sdk-tools.mjs:101`,
   `plugin-tools.mjs:141` and `cognia-tool-bridge.mjs:237` unlocks the two modules already
   plumbed for it.
6. **Unify the result envelope** for Family B, and make `plugin-tool-ipc.ts` able to return
   `{error}` so a failed host-routed tool reaches the model as a tool error.
7. **Decide what `allowedTools` means** and adapt at the boundary. Either set the SDK's `tools`
   option on the Anthropic rail to make it a real whitelist, or rename the field on the other
   two rails. One field with two meanings is not survivable.
8. **Make the sidecar test glob authoritative** (P2-0) and add a check that every `*.test.mjs`
   under `sidecar/` is matched by it. Until this lands, every other fix here can regress
   silently in five directories — including the confinement logic behind SEC-1 and SEC-2.
9. **Validate input on the external-agent bridge.** `cognia-tool-bridge.mjs:237` should
   `parse` with the zod shape it already builds to advertise the schema, instead of passing raw
   JSON-RPC arguments through. That single change restores every `.default()`, `.min()`,
   `.max()` and `.enum()` for all 83 built-ins on that rail (SEC-12).

---

## 11. Corrections to the 2026-07-18 note

Re-verified against code rather than inherited. Three of its conclusions no longer hold:

- **"Remaining opportunity #2 — push-driven monitoring" is closed.** `Monitor`,
  `monitor_cancel`, `monitor_list` ship today in the `coreFiles` category, backed by Rust
  `crates/cognia-jobs`. The note lists it as unbuilt.
- **"Remaining opportunity #3 — checkpoint/rewind and worktree lifecycle tools" is partly
  moot.** `EnterWorktree`/`ExitWorktree` ship natively in the SDK, and SDK-owned checkpoint
  control (`readFile`, `rewindFiles`, `seedReadState`) already exists behind the `checkpoint`
  capability (`sidecar/dispatch/control.mjs:15-39`), surfaced in
  `components/chat/checkpoint-action.tsx`. What is genuinely missing is agent-facing access,
  not the mechanism.
- **Its own verification contract is unmet.** The note requires that "English and Chinese tool
  catalog messages remain in parity"; 9 `codegraph_*` keys are missing from both locales (§7).
- Its claim that waitable `bash_output`/`list_shells` are closed holds on the desktop, but not
  on the external-agent bridge or the headless CLI (P0-4, P0-5).

`ADR-0002` is also stale on this subject: it names five `builtinTools` categories; there are
twelve. That is an ADR change and is left for a separate decision.

---

## 12. Appendix and coverage boundaries

**Quick-checked, no P0-class defect found**: `lib/plugin/registries/native-anthropic-tool-registry.ts`
— three first-party Anthropic tools (`computer_20251124`, `bash_20250124`,
`text_editor_20250728`) whose contracts this repo does not control.

**Covered in full**: all 83 Family A tools, ~35 Family B tools, 5 A2UI tools — every handler
read top to bottom, every declared parameter traced.

**Explicitly not covered:**

- Plugin-contributed tools (`plugins/**`) beyond the reachability question in §8. The ~23
  `browser_*`, 7 computer-use, and `wf_*` families were not individually audited.
- MCP server tools from user configuration.
- Runtime behaviour. No live desktop session was driven and no tool was invoked to prove a
  gate's behaviour, except the two cases marked _empirically verified_. The Anthropic-rail
  reachability of the six SDK-native tools (§9.1) is a static conclusion and should be
  confirmed before any work is scheduled against it.
- Windows and Linux path behaviour was reasoned about from code, not executed. Several
  findings (SEC-9's `path.sep` split, case folding) are platform-specific.
- Severity ranking is by reachability and blast radius, not by exploit development. No proof
  of concept beyond the two verified handler executions was constructed.
