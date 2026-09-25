# GitHub Devin Bot

An installable Cognia Bot plugin that maintains one github.com repository you choose. It reuses the Bot control plane, GitHub Delivery, shared decisions, isolated workspaces, and the Devin ACP adapter. The plugin has no HTTP client with credentials, queue database, scheduler, approval UI, or CLI launcher of its own.

## Install and configure

Build with `pnpm --dir plugins/github-devin-bot build`; install the resulting plugin directory or create an archive with `pnpm --dir plugins/github-devin-bot pack:plugin`. Install/enable GitHub Delivery first, then this plugin. In the existing Bot installation screen, bind the `github` credential slot, enter the repository as `owner/repo` (required — the plugin ships no default, and a run without one stops with a setup error), select the exact SWE-2 model, and select a Desktop or Headless host with authenticated Devin CLI and isolated-workspace support. Arm the repository monitor and GitHub event triggers. Web and mobile provide monitoring and approvals through that paired host.

Desktop and Headless use the host's native isolated-workspace provisioning and Devin ACP execution. Missing host capabilities or credentials require setup before execution. Headless native startup, workspace roots, directory creation, and file metadata have been exercised; the complete clone-to-Devin-to-approved-publication acceptance still requires separate live validation.

**github.com only.** The Bot reads through the host's repository-scoped request broker, which confines every read to the bound account's API origin, but the plugin SDK does not yet tell a Bot what that origin is. Accounts on GitHub Enterprise Server therefore cannot be used with this Bot; bind a github.com account.

The plugin does not embed credentials or automatically grant GitHub write access. An unavailable credential, host, or exact model prevents execution; there is no model fallback. GitHub App permissions must allow repository contents, issues, pull requests, checks, and Actions reads; publication also needs contents and pull-request writes. Fork repositories require their own explicit binding before publication.

Execution and publication are separate settings. Existing installations default to `executionMode: "approval"` and `publicationMode: "approval"`. `executionMode: "unattended"` requests automatic command execution only when the host explicitly grants `maxAuthority: "bypassPermissions"`. `publicationMode: "automatic"` requests an audited policy decision for the exact patch/review only when the host grants `maxAutonomy: "autopilot"` and `requireApprovalForWrites: false`. Organization, workspace, and host ceilings still apply. Neither setting permits merging. Change these settings and their grants through the existing installation configuration; they do not upgrade a recorded in-flight invocation.

## Behavior

- Poll every minute; reconcile every five minutes when verified webhook ingress is configured. Persist an activation watermark and cursor. Read all pages and honor rate-limit backoff. CI checks still run when the PR list returns HTTP 304.
- Queue new issues for implementation, non-draft PR heads for review, and failed current CI revisions for repair. Event and poll paths share stable work identities. Closed items cancel obsolete work. Generated PR markers and durable host provenance suppress recursive review/implementation.
- Use one execution per repository, a maximum 30-minute active execution, and two repair attempts. Reviews are read-only and publish structured COMMENT, REQUEST_CHANGES, or APPROVE verdicts with optional exact-line findings. Subsequent reviews use the last published review revision after checking ancestry; force-pushed or missing revisions receive a full review. Already-reviewed heads are skipped.
- Approval or change-request verdicts on PRs authored by the bound account become comments, preserving the review text and inline findings. When a credential cannot identify its actor (including GitHub App tokens that cannot read `/user`), the plugin also publishes a comment explaining that limitation. The provider independently rejects self-approval.
- Capture a patch, model/session, and the agent's command report. Command reports are explicitly **agent-reported**, not independent host verification. Missing or failing reported tests block repair publication.
- Human publication approval waits up to seven days on the existing decision surface; automatic mode uses the same immutable decision record with host-verified policy provenance. Approval binds the exact diff, review/PR body, verdict, inline findings, branch, and SHA. Recheck the item and target head before publishing. Denial, expiry, cancellation, and stale targets never publish.
- Follow published heads through CI without recursively reviewing generated PRs. New CI state is recorded once per change; successful reruns supersede old failures. A CI repair opens a separate PR targeting the failing PR's branch, rechecks that failure before publishing, and respects the configured attempt limit. If plugin correlation metadata is missing after restart, recover it only when a host-owned publication record matches the current PR repository, branch, commit, and exact Bot marker. Missing or conflicting repair lineage retains the exhausted limit instead of resetting the budget.
- Publish from a `cognia/github-devin/<kind>-<number>-<sha>` branch as a separate PR targeting the original branch, never merge. A fork that cannot be published retains its patch. Reconcile exact remote output before retrying uncertain writes.
- If a Devin turn may have executed before a disconnect, reconnect for inspection, retain the session and patch, and stop as blocked with a `recovery_required` diagnostic. An explicit retry creates a new Bot run; the uncertain prompt is never silently dispatched again.

Historical work is explicit: run the `backfill` trigger with `{"numbers":[12,34]}`. An empty backfill fails instead of launching the backlog. Installation configuration remains editable in the existing form.

## Operational evidence

The existing Bot run list distinguishes sync success, skipped work, rate-limit backoff, blocked verification, pending approval, stale approval, and publication failure. Monitor health records the last successful read and actionable error. Disable the installation to stop new work; retained runs and snapshots support inspection and recovery.

Fixture tests cover authentication-free monitor/execution flows and recovery contracts. Real Devin execution, paired-host UI, public GitHub writes, and CI outcomes require separate runtime validation. No plugin test creates a public issue, comment, or PR.
