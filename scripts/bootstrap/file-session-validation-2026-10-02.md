# Native file inputs and session commands — 2026-10-02

The copied standalone Bash and PowerShell scripts passed **10/10 acceptance
checks**, including six authenticated model interactions with DeepSeek `deepseek-flash`.
Both read explicit task/context files, returned the expected sum, exported
conversations and resumed them with the original or the other runtime.

## Source identity and environment

Validation ran on macOS ARM using Bash 3.2 and PowerShell 7.6.6. PowerShell was
extracted into a temporary directory from Microsoft's official osx-arm64 release;
its archive SHA-256 was verified before extraction. Neither runtime invokes
Python, Node, Cognia or an embedded C# engine. Python only orchestrates development
tests and their HTTP fixture.

| Runtime    | SHA-256                                                            |
| ---------- | ------------------------------------------------------------------ |
| Bash       | `3527e5c3c7472045ded524acd23265e84126ae845aecbc474736897f61da300c` |
| PowerShell | `fd4caef329266ba7e8d75a9723b35c7a14dddbe4dd342d1076d6854a612d5b54` |

## Authenticated acceptance

Each script was copied into its own temporary directory without sibling runtime
files. Configuration used the built-in DeepSeek provider and chat preset.
The only task data sent was a synthetic instruction, numbers `3`, `5`, `8`, and
the codeword `violet`. No repository files were uploaded.

| Check                                           |    Bash | PowerShell | Evidence                                                                                        |
| ----------------------------------------------- | ------: | ---------: | ----------------------------------------------------------------------------------------------- |
| Configure copied script                         | 0.157 s |    7.821 s | Valid provider/task configuration with an environment credential reference                      |
| File task, attachment, history, export and save | 2.010 s |    1.675 s | Real model returned `FILE_SUM=16 REMEMBER=violet`; explicit export worked under `--no-session`  |
| Local commands without a credential             | 0.978 s |    0.615 s | Removed API key; history, transcript export and configuration save succeeded                    |
| Resume own exported session                     | 2.165 s |    1.321 s | Real model recalled `violet` from the exported history                                          |
| Resume other runtime's export                   | 2.262 s |    1.418 s | Bash read PowerShell's transcript and PowerShell read Bash's transcript; both recalled `violet` |

Times are single-run wall-clock observations, not benchmark results. The harness
checked all retained configurations, transcripts, scripts and logs for the exact
credential value; none contained it. Local-provider tests separately assert zero
HTTP requests for local commands.

## Regression cases and repaired defects

The shared suite exercises UTF-8/BOM handling, task precedence, invocation-relative
paths, ordered/duplicate/empty attachments, per-file and aggregate limits, failed
turn retention, privacy blocking before setup or outbound requests, local history
bounds, no-credential commands, no-overwrite export and session resumption.
Runtime-specific cases include POSIX FIFOs/symlinks and interpreter behavior.

The final Bash suite passed **84/84** checks (62 shared and 22 runtime-specific)
in 231.123 s. The final PowerShell process suites passed **62/62 shared** checks in 133.051 s
and **16/16 runtime-specific** checks in 28.625 s. These suites use a local HTTP
fixture and actual runtime/child processes, distinct from the live provider
acceptance above. No coverage run was requested or performed.

Bash syntax, ShellCheck, Python test-harness compilation, scoped Markdown
formatting and `git diff --check` passed. Source hashes match the independently
copied scripts used by the final live acceptance run.

Acceptance reproduced and repaired these defects before final validation:

1. macOS `iconv` accepted an out-of-range Unicode scalar. Bash now validates UTF-8
   scalar boundaries using its existing `od` and `awk` dependencies; malformed,
   overlong, surrogate and truncated sequences are rejected.
2. Bash's eager chat credential prompt prevented offline local commands. Keys are
   now requested only for model/discovery calls, then included in the outbound
   privacy guard and scrubbed from child environments.
3. PowerShell's added whole-transcript guard treated `role<TAB>JSON` framing as raw
   text and falsely blocked newline escapes before file offsets. Complete history
   and each encoded JSON record remain gated before export; the framing is not
   reinterpreted as user text. Raw and nested sensitive values still fail tests.
4. A destination symlink inserted after Bash's export path check caused `ln` to
   publish inside the linked directory. POSIX `link` now publishes to the exact
   destination and refuses existing files, directories and symlinks. A deterministic
   wrapper injects the race in the regression test.
5. Bash 3.2 could defer Ctrl+C during a hidden credential read. Bounded character
   reads now let cancellation and execution budgets interrupt that prompt. Echo
   is disabled before displaying the prompt, preventing an immediately entered
   key from appearing while the hidden read starts. A real PTY test checks
   cancellation, recovery, no echo, child scrubbing and private persistence.

## Evidence boundaries

These checks exercise the standalone scripts. This change does not modify the
Cognia UI or claim a new desktop environment-launch acceptance result. Windows
and Linux execution were not performed in this session. Parent-directory
replacement by another process remains subject to the existing filesystem helper
limitations; the scripts run with the caller's permissions, without an OS sandbox.

The retained local live harness and redacted artifacts are at
`/private/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-files-final-live-stw01tsj/`.
Temporary evidence may expire; behavioral regressions remain in the three
bootstrap test scripts.
