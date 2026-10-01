# Repository, issue, and PR/MR integration audit

Research date: 2026-10-01, Asia/Shanghai.

Repair follow-up: the user subsequently authorized verification and fixes. See [repair results](2026-10-01-repository-integration-repairs.md) for the current F1–F10 status and new verification evidence. The findings and probe outputs below preserve the original pre-repair audit snapshot.

The current implementation has substantial GitHub functionality, but does not yet provide a complete multi-provider repository/issue/PR management system. GitLab and Bitbucket appear in the clone layer; that does not establish their issue/MR integrations. Several GitHub edge cases fail even though the existing focused test suites pass. The repair direction should reuse the current issue, review, integration-action, and forge abstractions.

This phase changed research artifacts only. It did not change application source, credentials, Git remotes, external issues, PRs, reviews, or webhook configuration.

## Scope and evidence boundary

- Inspected working-tree source at HEAD `6c7de49f525d23aca58f4eb1cac143349bf6a353`, verified unchanged at the end of the audit. The workspace has extensive pre-existing uncommitted work, including runtime initializers and `src-tauri/src/github/mod.rs`; findings describe the working tree, not a clean release build.
- Reviewed issue, source-control, review, integration, GitHub delivery plugin, forge, and relevant ADR paths. The local CodeGraph index/MCP was unavailable, so the inventory used file discovery, literal searches, and source reads.
- Read current official GitHub/GitLab documentation. [Provider baseline and source list](repository-integration-audit-2026-10-01/provider-research.md) records current API differences and deployment caveats.
- Ran existing Jest suites without coverage. Ran synthetic probes loading actual TypeScript implementation with injected network/storage boundaries. These establish local control-flow behavior, not successful authenticated provider operations.
- No app server was listening on port 3000. No browser/Tauri user journey, authenticated cloud/self-hosted account, native Rust Git operation, webhook public ingress, or actual merge was verified in this phase. No new server/build was started; available disk was about 7.9 GiB.
- Historical Bot verification was used only to locate existing reuse seams; historic live results are not counted as current acceptance evidence.

## Current capability inventory

| Area                                     | Existing implementation                                                                                                                                                  | Boundary / gap                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local repository operations              | `components/source-control`, `lib/git/commands.ts`, `crates/cognia-git`; clone, branches/remotes, diff, stage/commit, sync, stash, worktrees, conflict/rebase interfaces | UI component tests are not native Git/SSH/credential acceptance. Guarded clone defaults include github.com, gitlab.com, bitbucket.org (`crates/cognia-git/src/repo.rs:91`).                   |
| Forge identity                           | `lib/stack/forge/remote.ts`, `forge-session.ts`, `lib/github/host.ts`                                                                                                    | GitHub.com and configured GHES recognized; GitLab/Gitea/Bitbucket have no implemented forge adapter in this path.                                                                             |
| GitHub account and repository discovery  | App/PAT setup, lifecycle/health, repository listing, host-aware read credential resolution                                                                               | Reads already have a useful host-scoped resolver. Issue writeback selects the newest enabled account without target identity; see F1.                                                         |
| Local issue management                   | `/issues`, `/projects`, `IssueConsole`, board/list/detail/editors, planning/relations, cycles, triage, runs, notifications                                               | This is an existing shared product surface, not a reason to build another GitLab board. Local hierarchy/dependencies do not imply remote GitHub/GitLab parity.                                |
| GitHub issue mirror                      | Paginated issue reads, PR filtering, conditional reads, cached mirror, comments, comment/label/close writeback                                                           | 404 and capped-read recovery defects; see F4/F5.                                                                                                                                              |
| GitHub issue import / bidirectional sync | `IssueSyncProvider` + shared engine; title/body/status/assignee/labels/milestone; conflict events; PR links and limited CI observation                                   | Projects iteration reads are partial. Iteration writes can falsely report applied; see F7. No GitLab issue provider is registered.                                                            |
| Runtime wiring                           | `app/layout.tsx:309` mounts initializer; `lib/headless/runtimes/index.ts:169` imports headless tracker; both call `lib/issues/boot.ts`                                   | Boot registers GitHub plus Lark Task/Bitable sync providers and existing sources. This verifies source wiring, not a launched desktop/headless session.                                       |
| GitHub PR delivery                       | Delivery plugin exposes open/close/merge/review/inline review/comment; release/tag actions also exist                                                                    | It already implements APPROVE and REQUEST_CHANGES with exact-head validation. Do not implement a second equivalent handler.                                                                   |
| PR UI / review                           | `UnifiedReviewSheet`, shared review workspace/bundles/diff components; current-branch PR lookup/create/push; stack publish/merge                                         | Review UI publication is a separate implementation from plugin review actions and loses important safety semantics. No complete cross-repository PR/MR inbox was found in the audited routes. |
| PR state / CI / review observation       | `lib/github/pr-observe`, stack forge, feedback/delivery observers                                                                                                        | Capabilities are distributed across observers, plugin actions, and UI. Issue-side PR discovery scans only latest 50 PRs and checks CI on up to 10 linked open PRs per pass.                   |
| Automation                               | Existing issue run adapters, integration jobs/approvals/retries, webhook normalization, Bot infrastructure                                                               | Reuse existing execution/approval/durability. Live delivery, restart recovery, duplicate webhook handling need separate current acceptance.                                                   |

## Confirmed defects and concrete limitations

Priority is proposed engineering triage, not a claim about observed production incidents. Source references below are repository-relative and refer to this audit snapshot.

### F1 — P1: issue writeback can choose the wrong host/account

`lib/issues/github-writeback.ts:75` selects the first enabled account from the newest-first account list; neither repository nor host is an input. `GithubWritebackTarget` carries only `repoFullName` and issue number. `lib/integrations/action-runner.ts:276` checks integration/account/schema eligibility, then passes the chosen account's API base at line 420. The delivery plugin builds the target URL from that base.

Synthetic observation: a github.com issue payload `acme/repo#42`, with a newer GHES account, becomes `POST https://ghe.example/api/v3/repos/acme/repo/issues/42/comments`. If a same-named target exists and the account has access, the wrong target can receive the write; otherwise the operation fails against the wrong host. The probe executes real account selection and plugin URL construction, while injecting the action-runner account-to-host seam; it is not an end-to-end approval/network test.

Reuse `lib/integrations/github-read-credential.ts` host-scoped identity selection. Bind and revalidate host/account/repository for writes and retry/approval jobs; do not infer the target from whichever account was most recently edited. The issue resource model itself needs host identity (`types/issues/index.ts:172`).

### F2 — P1: cached PR feedback can be sent to another repository

`lib/review/github-provider.ts:218` resolves the current root binding but uses the cached PR number without comparing `pullRequest.repository`. The existing `resolveCheckout` path checks repository identity at line 149; publishing lacks that check.

Synthetic observation: feedback for cached `old-owner/old-repo#42` produces a review request for `new-owner/new-repo#42` after the root binding changes. The actual bundle validation ran and did not prevent this. Reject repository/host/head drift at publication using the shared review contract, then resolve the target again.

### F3 — P1: repository-local milestone numbers collide globally

`lib/issues/sync/providers/github.ts:109` returns `milestone/1` for milestone number 1 in every repository. `lib/db/issue-cycles.ts:124` looks up globally by provider/external ID, and `lib/issues/sync/engine.ts:112` updates an existing match without checking its workspace/container.

Synthetic observation using the actual sync engine and cycle DB module with in-memory storage: sync milestone 1 from repository A into workspace A, then milestone 1 from repository B into workspace B. Only one row remains, still owned by workspace A, but its name and binding are overwritten by B. Scope external milestone identity by host/repository, and validate local ownership. Existing cycle storage/planning UI should remain the shared implementation.

### F4 — P1: HTTP 404 during full refresh deletes the cached mirror

`lib/github/issues.ts:91` normalizes 404 to an empty response; the fetch then reports a complete, unmodified-false result. `lib/issues/github-sync.ts:104` prunes the cache for a full non-truncated read.

Synthetic observation: two cached issues, a thrown HTTP 404, and `full: true` return `removed: 2`, leaving zero cached issues instead of reporting a read failure. GitHub can return 404 for inaccessible private resources, so it is not evidence that the issue list is empty. [Official troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)

Preserve cache and surface authorization/not-found uncertainty through the existing error channel. Only a successful complete listing can justify absence-based pruning.

### F5 — P2: a capped initial import can permanently skip older issues

`lib/github/issues.ts:46` caps the walk at 10 pages of 100 API records. `lib/issues/github-sync.ts:97` persists the partial rows; subsequent sync derives `since` from their newest update. The import engine also computes the maximum seen update (`lib/issues/sync/engine.ts:92`) while only reporting `truncated` as a tally.

Synthetic observation with 1,001 issues: full refresh imports 1,000 and sets truncated; next incremental refresh reads one boundary issue, reports non-truncated, and still never imports issue 1. PR records included by GitHub's Issues endpoint can reduce the number of actual issues imported below 1,000. Full refresh repeats the same capped beginning. `lib/issues/sync/describe.ts` does not surface truncation as incomplete.

Reuse the existing reader and engine, adding resumable pagination/checkpoint semantics or an explicit incomplete-import state. Do not advance a completeness watermark past unprocessed records.

### F6 — P2: ProjectV2 iteration mapping joins issues by number only

The query at `lib/issues/sync/providers/github.ts:198` requests only `Issue.number`; line 380 maps iteration by that number. A Project can span repositories. The current `Repository.projectV2(number)` query itself is valid; the defect is missing content/repository identity, not a nonexistent GraphQL field. [Repository schema](https://docs.github.com/en/graphql/reference/repos), [cross-repository Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions)

Synthetic observation: A#7 and B#7 in one Project; B's iteration overwrites A's mapping, and the imported A#7 receives B's iteration. Query and match issue node ID or host/repository/number, preserving item type.

### F7 — P2: iteration changes report success without a write

The provider declares `cycle` push support, but `toUpdateIssueInput` at `lib/issues/sync/providers/github.ts:306` serializes milestones only. A patch containing `iteration/new` produces only the two target fields; line 565 returns `{ status: "applied" }` without executing any integration action.

Synthetic observation: changing the iteration returns applied with exactly zero remote writes. Either implement ProjectV2 field mutation through the existing action system, or represent iteration as non-writable and prevent/report the unsupported edit. Do not consume a local change as synchronized when the provider cannot apply it.

### F8 — P2: GHES-only credentials cannot unlock the review UI

`lib/review/github-runtime.ts:34` uses a github.com credential for global authentication state. The review sheet disables lookup/push/create while that state is unauthenticated (`components/source-control/unified-review-sheet.tsx:387`, 435, 442), even though repository lookup resolves host-specific clients correctly.

Synthetic observation: no github.com token + valid GHES client yields unauthenticated, while a direct lookup through the same provider succeeds. Authentication/capability should be evaluated per selected root using the existing host resolver.

### F9 — P2: review push hardcodes origin

`lib/review/github-provider.ts:179` pushes to `origin`. The repository resolver can select a different remote when origin is absent (`lib/ai/agent/team/pr-feedback/resolvers.ts:97`). An upstream-only checkout can resolve the PR but its UI push targets a nonexistent remote.

Synthetic observation confirms the dispatched Git arguments always contain `remote: "origin"`. Preserve the selected remote in the existing repository binding and pass it to the shared Git command.

### F10 — P2: UI review publication omits the plugin's exact-head semantics

`lib/review/github-provider.ts:224` places `commit_id` inside individual review comments; its create-review request omits top-level `commit_id` and hardcodes COMMENT. The official create-review contract places `commit_id` at the review level; omitting it chooses the current latest commit. [GitHub reviews API](https://docs.github.com/en/rest/pulls/reviews)

The delivery plugin already validates exact current head, handles verdicts/self-review/retry deduplication, and emits top-level `commit_id` (`plugins/github-delivery/src/index.ts:441`, 473, 553). Reuse those semantics. The probe captures the UI request shape; no live provider rejection or stale-head mutation is claimed. Stack merge also lacks an expected SHA guard in the examined adapter; track that as additional source-level hardening rather than a reproduced merge incident.

## Capability gaps against current provider contracts

- **GitLab first-class integration:** no registered GitLab repository/issue/MR adapter was found. Add provider-specific auth/host/nested-namespace identity, issue sync, MR discussion/approval/pipeline/merge mapping behind the existing interfaces. Generic Git clone is already available.
- **Other forges:** Gitea/Bitbucket PR/issue adapter support is absent in the audited path. Prioritize actual user targets before adding adapters, while retaining shared UI/capability contracts.
- **Modern GitHub issues:** local parent/child and relation features exist, but no outbound/inbound native sub-issue, dependency, or issue-type mapping was found in the GitHub provider/actions. Current GitHub exposes these APIs. [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [dependencies](https://docs.github.com/en/rest/issues/issue-dependencies), [issues](https://docs.github.com/en/rest/issues/issues)
- **Planning completeness:** Projects support currently reads iterations, not a complete editable project field model. Milestones read only the first 100; Project items cap at 20 pages, fields at 50, item field values at 20, without complete truncation/error reporting. The GraphQL response model ignores errors; permission/partial-response behavior needs a dedicated test.
- **PR management completeness:** existing plugin verdict/merge functionality must not be counted as absent, but reviewer requests, review-thread reply/resolve/reopen, editable PR metadata/draft lifecycle, aggregate inbox/filtering, auto-merge/merge queues are not established as complete user-facing flows in the audited surfaces. GitLab approvals and discussions must remain distinct from ordinary comments. [GitHub GraphQL PRs](https://docs.github.com/en/graphql/reference/pulls), [GitLab approvals](https://docs.gitlab.com/api/merge_request_approvals/), [GitLab discussions](https://docs.gitlab.com/api/discussions/)
- **Observation completeness:** latest-50 PR linking and latest-10 eligible CI reads can leave older linked PRs/checks stale indefinitely when newer candidates keep occupying the budget. Follow already-linked PR identities directly and use fair, bounded scheduling within the existing observer.
- **Live regression protection:** the existing issue/source-control tests are substantial but missed the probes above. Authenticated UI, self-hosted-only accounts, multi-account same-name repositories, >1,000 issue backfill, cross-repo Projects, and stale-head review/merge journeys need explicit acceptance cases.

## Reuse-first implementation sequence proposed for discussion

1. **Identity and data correctness:** fix F1–F6 using shared host/repository/account identities, cycle keys, existing sync engine/checkpoint/error semantics, and review target validation. Verify with the saved synthetic scenarios promoted into co-located regressions plus disposable real-account tests.
2. **Unify review behavior:** preserve `UnifiedReviewSheet`, `use-review-workspace`, `ReviewFeedbackBundle`, diff/line-anchor components and `PullRequestProvider`. Share delivery-plugin exact-head/review/approval/idempotency behavior rather than introducing another PR editor or unsafe direct HTTP path. Fix F7–F10 at those seams.
3. **Add GitLab adapter:** extend `ForgePort`, `PullRequestProvider`, `IssueSyncProvider`, existing integration accounts/jobs and capability UI. Keep GitLab-specific project IDs/namespaces/discussion positions/approval rules inside the adapter. Reuse `IssueConsole`, planning components, `SourceControlPanel`, `StackPanel`, and existing approval surfaces.
4. **Finish management gaps:** native issue hierarchy/dependencies/types, provider planning fields, review lifecycle, queues and large-data correctness. Gate by provider/instance/version/tier capabilities; unsupported actions should have explicit UI outcomes.

No phase is implemented by this report. No new parallel issue database, GitLab-specific board, PR diff viewer, token store, job queue, or agent runtime is recommended.

## Test evidence

| Run                                                                                    | Result                                                                                            | Evidence                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Issue implementation/UI/boot/headless focused Jest                                     | 137 suites, 1,681 tests passed; 47.144 s                                                          | [issues-jest.log](repository-integration-audit-2026-10-01/issues-jest.log)                                                               |
| Expanded GitHub integrations/auth/host/PR observation/forge/plugin/source-control Jest | 64 suites, 753 tests passed; 21.758 s                                                             | [forge-expanded-jest.log](repository-integration-audit-2026-10-01/forge-expanded-jest.log)                                               |
| Initial review/forge smoke Jest (overlaps expanded run)                                | 7 suites, 104 tests passed; 5.045 s                                                               | [forge-jest.log](repository-integration-audit-2026-10-01/forge-jest.log)                                                                 |
| Actual-source issue probes with injected network/storage                               | Five distinct defect scenarios reproduced; milestone key collision also checked independently     | [runner](repository-integration-audit-2026-10-01/issue-probes.cjs), [outputs](repository-integration-audit-2026-10-01/issue-probes.json) |
| Actual-source review/account/handler probes                                            | GHES auth gating, origin hardcoding, stale repository target, and wrong-host destination observed | [runner](repository-integration-audit-2026-10-01/forge-probes.cjs), [outputs](repository-integration-audit-2026-10-01/forge-probes.log)  |

The first two batches are non-overlapping: **201 suites / 2,434 tests passed**. The initial 7-suite run is reported separately and must not be added wholesale. Passing existing suites does not negate the reproduced defects. These audit probes intentionally assert/print the defective behavior as evidence; they are not repaired-behavior regression tests.

Commands from the repository root:

```sh
rtk proxy pnpm exec jest --runInBand --testPathPatterns='^(lib/issues/|lib/github/issues.test|components/issues/|hooks/issues/|components/providers/initializers/issue-tracker-initializer.test|lib/headless/runtimes/issue-tracker.test)'
rtk proxy node docs/research/repository-integration-audit-2026-10-01/issue-probes.cjs
rtk proxy node docs/research/repository-integration-audit-2026-10-01/forge-probes.cjs "$PWD"
```

The expanded log records the exact 64 test paths. No coverage, repository-wide typecheck/build, Rust test suite, or live E2E pass is claimed.

## Inputs needed for live validation

1. Target repository URL for each desired provider; for GitLab/GHES, instance URL, product version and license tier. Name other required providers such as Gitea/Bitbucket if relevant.
2. A designated account connected through Cognia's existing account UI. Do not paste secrets into chat. Read-only repository/issue/PR/check access is enough for the first live phase; Project access can require separate permissions.
3. Allowed mutation scope for a disposable repository: create/edit/close test issues, create draft PR/MR, comments/reviews. A second reviewer account is needed to test actual approvals and self-review restrictions. Merge, webhook installation, and branch-policy changes should be separately scoped before execution.
4. Preferred runtime to verify: current Tauri desktop, Web/headless deployment, or both, plus a running instance/URL. Synthetic/headless component tests do not substitute for that choice.
5. Fixtures for larger acceptance: cross-repository Project items with equal issue numbers, milestones with equal numbers, >1,000 records, nested GitLab namespace, renamed/fork repositories, protected branches, failing/pending/passing pipelines, unresolved discussions, stale heads and retry-after/permission failures.

## Sources and current-version notes

GitHub currently documents REST versions `2026-03-10` and `2022-11-28`; omitted version defaults to the latter, supported until 2028-03-10. The plugin's older pinned version is therefore migration debt, not by itself a malfunction. [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)

GitLab's `/api/v4` does not identify the product release. Current docs describe fine-grained PAT GA in 19.2, `auto_merge` replacing deprecated `merge_when_pipeline_succeeds`, and instance policies that may require expected SHA on merge. Validate those against the actual deployment rather than assuming GitLab.com and all private instances behave identically. [Fine-grained PATs](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/), [MR API](https://docs.gitlab.com/api/merge_requests/)

The linked [provider baseline](repository-integration-audit-2026-10-01/provider-research.md) contains the detailed official API checklist and source URLs. Documentation was read live on the research date; no claim is made that an unspecified user's GitLab/GHES is on the newest documented release.
