# GitHub Devin Bot

An installable Cognia Bot plugin for `NJUPT-SAST/sast-approval-next`, configurable for another repository. It reuses the Bot control plane, GitHub Delivery, shared decisions, isolated workspaces, and the Devin ACP adapter. The plugin has no HTTP client with credentials, queue database, scheduler, approval UI, or CLI launcher of its own.

## Install and configure

Build with `pnpm --dir plugins/github-devin-bot build`; install the resulting plugin directory or create an archive with `pnpm --dir plugins/github-devin-bot pack:plugin`. Install/enable GitHub Delivery first, then this plugin. In the existing Bot installation screen, bind the `github` credential slot, retain or edit the repository, select the exact SWE-2 model, and select a Desktop or Headless host with authenticated Devin CLI and isolated-workspace support. Arm the repository monitor and GitHub event triggers. Web and mobile provide monitoring and approvals through that paired host.

Desktop and Headless use the host's native isolated-workspace provisioning and Devin ACP execution. Missing host capabilities or credentials require setup before execution. Headless native startup, workspace roots, directory creation, and file metadata have been exercised; the complete clone-to-Devin-to-approved-publication acceptance still requires separate live validation.

The plugin does not embed credentials or automatically grant GitHub write access. An unavailable credential, host, or exact model prevents execution; there is no model fallback. GitHub App permissions must allow repository contents, issues, pull requests, checks, and Actions reads; publication also needs contents and pull-request writes. Fork repositories require their own explicit binding before publication.

## Behavior

- Poll every minute; reconcile every five minutes when verified webhook ingress is configured. Persist an activation watermark and cursor. Read all pages and honor rate-limit backoff. CI checks still run when the PR list returns HTTP 304.
- Queue new issues for implementation, non-draft PR heads for review, and failed current CI revisions for repair. Event and poll paths share stable work identities. Closed items cancel obsolete work. Generated PR markers and durable host provenance suppress recursive review/implementation.
- Use one execution per repository, a maximum 30-minute active execution, and two repair attempts. Reviews are read-only. Subsequent reviews use the last published review revision.
- Capture a patch, model/session, and the agent's command report. Command reports are explicitly **agent-reported**, not independent host verification. Missing or failing reported tests block repair publication.
- Wait up to seven days on the existing decision surface. Approval binds the exact diff, review/PR body, branch, and SHA. Recheck the item and target head before publishing. Denial, expiry, cancellation, and stale targets never publish.
- Publish a separate PR targeting the original branch, never merge. A fork that cannot be published retains its patch. Reconcile exact remote output before retrying uncertain writes.
- If a Devin turn may have executed before a disconnect, reconnect for inspection, retain the session and patch, and stop as blocked with a `recovery_required` diagnostic. An explicit retry creates a new Bot run; the uncertain prompt is never silently dispatched again.

Historical work is explicit: run the `backfill` trigger with `{"numbers":[12,34]}`. An empty backfill fails instead of launching the backlog. Installation configuration remains editable in the existing form.

## Operational evidence

The existing Bot run list distinguishes sync success, skipped work, rate-limit backoff, blocked verification, pending approval, stale approval, and publication failure. Monitor health records the last successful read and actionable error. Disable the installation to stop new work; retained runs and snapshots support inspection and recovery.

Fixture tests cover authentication-free monitor/execution flows and recovery contracts. Real Devin execution, paired-host UI, public GitHub writes, and CI outcomes require separate runtime validation. No plugin test creates a public issue, comment, or PR.
