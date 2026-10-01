# Authenticated live validation — 2026-10-01

Both independently copied scripts were exercised on macOS ARM against
`https://api.deepseek.com`, using the existing `DEEPSEEK_API_KEY` environment
reference and the real `deepseek-flash` model. Model discovery returned HTTP 200.
The test harness did not mock or proxy model responses.

Only synthetic files in isolated temporary workspaces were sent to the model.
The credential value was neither printed nor written into configuration or
reports. Artifact scans confirmed it was absent from saved files and sessions.

## Final results

| Runtime    | Scenario                          | Elapsed | Model steps | Result |
| ---------- | --------------------------------- | ------: | ----------: | ------ |
| Bash       | Editor and persistent shell tools | 12.53 s |           5 | Passed |
| Bash       | Resume saved session              |  4.09 s |           1 | Passed |
| Bash       | Model-assisted initialization     |  5.33 s |           2 | Passed |
| Bash       | Readiness and state reuse         |  0.47 s |           0 | Passed |
| PowerShell | Editor and persistent shell tools | 16.07 s |          10 | Passed |
| PowerShell | Resume saved session              |  2.10 s |           1 | Passed |
| PowerShell | Model-assisted initialization     |  4.88 s |           2 | Passed |
| PowerShell | Readiness and state reuse         |  0.78 s |           0 | Passed |

The file task required the model to read `3`, `5`, and `8` from `input.txt`,
write `result.json` containing the numeric sum `16`, and use separate shell
calls to set and verify a variable. The second shell call also checked that
`DEEPSEEK_API_KEY` was absent from its environment. Saved sessions contained
actual editor and shell tool calls. A new process recovered the remembered
codeword `copper-lantern` from the session.

Initialization began with a missing `ready.txt` and no deterministic setup
command. The real model created the file; host readiness checks verified its
content. The next invocation reused the state with zero model steps. These two
reuse scenarios intentionally require no model request.

## Findings and fixes

- The first Bash calls returned relative editor paths, which violated the d.sh
  tool contract. The tool schema now describes absolute paths, and the system
  context supplies the canonical workspace root after resolving omitted or
  relative `--cwd`. The final live rerun passed without an explicit `--cwd`.
- PowerShell could create but not resume a session through macOS's
  `/var` parent alias. Session paths now canonicalize the parent while continuing
  to reject a symlink at the session file itself. Both regression and live
  session-resume tests passed.
- Earlier PowerShell initialization attempts were blocked by the privacy gate.
  Diagnostic instrumentation identified the Luhn bank-card rule, but the original
  triggering text was not retained. It is therefore unresolved whether this was
  a false positive or a genuine match in generated content. The gate was not
  disabled, relaxed, or bypassed. Subsequent isolated initialization runs and
  the final end-to-end run passed. This finding is **not claimed fixed**.

After the changes, Bash passed 45 local regression cases. PowerShell passed
33 shared cases and 6 interpreter-specific cases. Bash syntax and ShellCheck
also passed.

## Evidence and limits

The final copied scripts match these repository source hashes:

```text
Bash       cbcb0b577c13cca9f8e6862f3ea2390036da51eafee84a09ad26cff358f3c2e2
PowerShell f926869554fad11b1a14f6cbbb47b5114372135ca0e8fda5b9049cbaff506375
```

Local raw evidence, including configurations, sessions, generated files and
per-case stdout/stderr, is in these temporary directories:

```text
/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-live-bash-final-eieommxj
/var/folders/h3/mypbg9ks5cj9ht4p61ffnwz40000gn/T/cognia-live-ps-final-zeilyx3e
```

This verifies real authenticated model/tool execution on macOS with Bash 3.2.57
and PowerShell 7.6.6. It does not establish Windows/Linux execution, other model
providers, or a complete Cognia desktop UI flow.
