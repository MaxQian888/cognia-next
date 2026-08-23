---
"cognia-next": minor
---

Give security scans a stable identity, a triage workflow, SARIF export, and a CI command.

Findings now have an identity that survives a rescan. Previously each one carried only the scanner's own per-run id, so every scan reported everything as brand new and there was nowhere to record that you had already looked at something. A finding is now keyed by what it _is_ — the vulnerability class and where it lives — and deliberately not by its severity, its description or its line numbers, so rescoring a finding, rewording it, or editing the file above it does not turn it into a different finding.

On the back of that, findings can be triaged. Each one can be marked risk-accepted, a false positive, or fixed, and a whole vulnerability class can be muted for one target — including instances that have not been found yet, so an accepted class stops reopening the same task on every scan. Muting can be undone. Marking something fixed deliberately does _not_ mute it: if a finding you called fixed is still being reported, that contradiction is worth seeing.

Scan results export as SARIF 2.1.0, the format GitHub code scanning and most security dashboards already read. Proof-of-concept exploit code, technical analysis and code snippets are stripped on the way out — those are what the panel is for, not something that belongs in a CI log or a pull request. A scan whose report could not be read exports as an explicitly failed run rather than an empty one.

A new `cognia-agent security` command brings the same rules to CI. `security report` evaluates an artifact a previous step produced; `security scan` runs the scanner first. Both can compare against a baseline, export SARIF, and fail a build at a severity threshold you choose. Exit codes distinguish the two failures that matter: 2 means findings met your threshold, while 1 means the question was never answered — no authorization, a missing environment, or a report that could not be parsed. Only one of those is fixed by changing code. Running a scan headlessly requires explicitly asserting you are authorized to attack the target, and LLM credentials are read from the environment only, never accepted as a command-line flag where other processes and CI logs can read them.

Security scans also appear in the task cockpit alongside every other long-running job, with their target and status. A scan that finished but produced an unreadable report shows as failed rather than green — it may have found critical issues nobody could read. Only the target, a count and a status cross into that view; findings never do.
