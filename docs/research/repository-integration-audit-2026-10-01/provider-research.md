# GitHub / GitLab provider baseline

Research date: 2026-10-01, Asia/Shanghai. Read-only research of live official documentation. No authenticated application flow, private repository access, or remote mutation was performed. This is a provider capability baseline for comparison with Cognia, not a claim that Cognia implements it.

## Version-sensitive findings

- GitHub's currently documented supported REST versions are `2026-03-10` and `2022-11-28`. Omitting `X-GitHub-Api-Version` currently selects `2022-11-28`; its documented end of support is 2028-03-10. Pinning the old version remains supported, so it is migration debt rather than proof of broken behavior. Additive changes are available across supported versions. [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- When migrating to `2026-03-10`, audit removed singular `assignee` request/response fields and use `assignees`; `/rate_limit` consumers must use `resources.core` rather than the removed duplicate `rate`. [Breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)
- GitLab documents REST `/api/v4`, but that is not the installed GitLab product version. Record the actual instance version, license tier, feature flags and group/project policies before calling a missing feature an application defect. New API features can appear under the same `/v4` path. [REST API](https://docs.gitlab.com/api/rest/)
- Current GitLab MR docs record changes in 19.1 (auto-merge routing to merge trains) and 19.2 (policy requiring an expected source SHA). This is evidence for these specific features, not verification of a user's deployed release. [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- GitLab fine-grained PATs are documented as beta in 18.10 and generally available in 19.2. Token authorization intersects token resources/permissions with the user's access; enforcement can disable legacy PAT access. A UI claiming every PAT needs the old broad `api` scope is no longer a complete description. [Fine-grained PATs](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/)

## Capability and acceptance checklist

| Area                      | GitHub baseline                                                                                                                                           | GitLab baseline                                                                                                    | Acceptance checks proposed for Cognia                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account / authentication  | Fine-grained/classic PAT, App installation/user tokens, OAuth; endpoint permissions and SSO matter [G1]                                                   | OAuth, personal/project/group tokens; fine-grained tokens on compatible versions [L1,L2]                           | Account/host/repository identity stays attached to every request; expired/denied/SSO-required differs from empty data; no secret logging; switching accounts cannot leak cached data |
| Self-hosted               | GHES REST base is `https://HOST/api/v3`; server version can be obtained from response header or `/meta` [G2]                                              | Custom instance host with `/api/v4` [L3]                                                                           | Nested GitLab namespaces and URL encoding; cloud/custom-host base URLs; API and browser URLs kept distinct; credentials never forwarded to unrelated pagination/redirect hosts       |
| Pagination                | Follow REST `Link` relations; most endpoints cap `per_page` at 100 [G3]                                                                                   | Offset default 20/max 100; keyset on selected endpoints; totals may be absent on large result sets [L3]            | More than one page, exact page boundary, empty final page, old issues updated recently, cancellation/retry, duplicate suppression; no silent hard-cap truncation                     |
| Issues                    | List/create/read/update; state, body, assignees, labels, milestone, type; PRs are included in issue resources [G4]                                        | Issue create/edit/state, assignees, labels, milestone, confidential/due-date/type fields [L4]                      | Full readback after mutation, clear-to-empty fields, archived/denied repositories, closed versus reopened, issue/PR filtering                                                        |
| Hierarchy / relationships | Parent/sub-issues list/add/remove/reprioritize; blocking dependencies [G5,G6]                                                                             | Linked `relates_to`, `blocks`, `is_blocked_by`; work-item hierarchy uses separate model/API [L5,L6]                | Cross-repository identity, permissions on both ends, relationship direction, unsupported capability communicated                                                                     |
| Planning                  | ProjectV2 items/fields, draft issues and issue/PR items; projects can span repositories [G7,G8]                                                           | Work items cover additional epic attributes and hierarchy; migration documentation has feature-status caveats [L6] | Preserve remote identity, project/item/field IDs, item type and repository; page every relevant connection                                                                           |
| PR / MR lifecycle         | Create/read/update/close/reopen, draft/ready, changed files/commits, merge [G9,G12]                                                                       | MR create/read/update/close/reopen, draft, diffs/versions, pipeline, merge [L7]                                    | Fork/source/target identity, empty/large/binary/renamed diffs, stale head, closed vs merged state                                                                                    |
| Review                    | Reviews and review comments are different from ordinary issue comments; request reviewers, approve/request changes/comment, pending reviews [G10,G11,G12] | Approval actions/state/rules separate from discussion notes; re-auth and tier restrictions can apply [L8,L9]       | General comment cannot count as approval; aggregate actual current decision/rules; stale reviews after new commits                                                                   |
| Inline threads            | Review comment line/side/path/commit positions plus GraphQL thread reply/resolve/unresolve [G11,G12]                                                      | Discussions position requires base/head/start SHA and old/new paths/lines as appropriate [L9]                      | Added/deleted/unchanged lines, range comments, changed diff version, reply, resolve/reopen, permission failure                                                                       |
| Checks / merge safety     | Check runs by ref plus PR mergeability; `mergeable: null` means background calculation pending [G9,G13]                                                   | `detailed_merge_status` covers CI, conflicts, approvals, unresolved discussions, draft etc. [L7]                   | Pending/unknown never displayed as safe; exact reviewed head checked before merge; distinguish merge request accepted vs actually merged                                             |
| Auto-merge / queues       | GraphQL enable/disable auto-merge, enqueue/dequeue merge queue [G12]                                                                                      | Use `auto_merge`; `merge_when_pipeline_succeeds` deprecated since 17.11 [L7,L10]                                   | Required checks/approvals and project policy; queued/scheduled vs merged; cancellation and head changes                                                                              |
| Rate / errors             | 403 or 429; respect remaining/reset and Retry-After; bounded increasing backoff [G14]                                                                     | 429 with Retry-After; instance/plan limits vary [L1]                                                               | Retryable error distinct from auth denial; preserve user edits; bounded retries; no duplicate mutation on ambiguous failure                                                          |

Acceptance checks above are engineering recommendations inferred from the documented contracts, not provider guarantees about a specific Cognia implementation.

## Specific GitHub Projects query question

`repository(owner: ..., name: ...) { projectV2(number: ...) { ... } }` is valid according to the current official GraphQL `Repository` schema, which explicitly lists `projectV2(number: Int!)`. Do not flag that field as nonexistent based on older assumptions. [Repository schema](https://docs.github.com/en/graphql/reference/repos)

A Project can contain content from multiple repositories. Therefore an importer that joins ProjectV2 content to an imported issue only by `Issue.number` can attach another repository's status to the wrong issue. Query and match an immutable issue/node identity, or repository identity plus issue number; also preserve the item type. This is an inference from the documented cross-repository project model. [Projects across repositories](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions), [ProjectV2 item content types](https://docs.github.com/en/graphql/reference/projects)

Organization-project authorization is distinct from repository-project authorization. The Projects automation guide says repository-level `GITHUB_TOKEN` cannot access Projects and that organization Projects require organization-project permissions. Successful repository/issue reads therefore do not establish ProjectV2 read access. [Projects authorization](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions)

## Critical merge semantics

- GitHub mergeability may be null while calculation runs. REST merge supports an expected head `sha`; stale-head responses must not be treated as a successful merge. The merge method is part of the request and repository configuration constrains it. [Pull requests API](https://docs.github.com/en/rest/pulls/pulls)
- GitLab's `has_conflicts` depends on asynchronous merge-status calculation and is not sufficient to prove a request is mergeable. Prefer `detailed_merge_status`; use a bounded refresh while checking. Expected source `sha` is conditionally mandatory under the documented 19.2 policy; mismatches return 409. `auto_merge` schedules completion when checks pass. [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- GitLab approval lists and rule satisfaction are different resources. `/approval_state` reports per-rule satisfaction; merely counting `approved_by` can misrepresent eligibility. The documentation marks approval-rule detail endpoints Premium/Ultimate, so capability gating matters. [Approval API](https://docs.gitlab.com/api/merge_request_approvals/)

## Live validation inputs to request only if needed

1. Target provider/host and one disposable test repository per provider; for self-hosted providers, installed version and tier.
2. A designated test account connected through Cognia's existing credential UI; never ask the user to paste tokens into chat. Read permissions for repositories/issues/PRs/checks/pipelines first; add narrow write permission only when the user approves the mutation phase.
3. For comprehensive write verification: a disposable issue, draft PR/MR, two test branches, a second reviewer account, and branch policies/CI configured to exercise pending/failing/passing checks, approval rules, unresolved threads and conflicts.
4. Explicit authorization before creating external issues/comments/reviews, merging, changing branch policies or installing webhooks. Local synthetic tests and public read-only calls can establish narrower evidence without these inputs.

## Documentation uncertainty

The GitLab epic-to-work-items migration guide currently mixes historical GA notes with Beta/experimental wording and prospective removal timing. Treat the guide as migration direction, not proof that every advertised work-item field is available on every deployed version; inspect the target instance's schema/capabilities. [Migration guide](https://docs.gitlab.com/api/graphql/epic_work_items_api_migration_guide/)

Cloud docs and schemas change continuously; the URLs here were read on the research date, not pinned release snapshots. This research did not select an arbitrary latest GitLab product version. GitHub Projects examples use GraphQL, but that is not a claim that no equivalent REST Project endpoints exist.

## Sources

- G1: [GitHub REST authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)
- G2: [GitHub Enterprise Server API base/version](https://docs.github.com/en/enterprise-server%403.21/rest/enterprise-admin)
- G3: [GitHub pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- G4: [GitHub Issues API](https://docs.github.com/en/rest/issues/issues)
- G5: [GitHub sub-issues API](https://docs.github.com/en/rest/issues/sub-issues)
- G6: [GitHub issue dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies)
- G7: [GitHub Projects API guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- G8: [GitHub Projects automation and authorization](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions)
- G9: [GitHub Pull requests API](https://docs.github.com/en/rest/pulls/pulls)
- G10: [GitHub reviews API](https://docs.github.com/en/rest/pulls/reviews)
- G11: [GitHub review comments API](https://docs.github.com/en/rest/pulls/comments)
- G12: [GitHub GraphQL pull requests](https://docs.github.com/en/graphql/reference/pulls)
- G13: [GitHub check runs API](https://docs.github.com/en/rest/checks/runs)
- G14: [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- L1: [GitLab REST authentication and rate handling](https://docs.gitlab.com/api/rest/authentication/)
- L2: [GitLab fine-grained PATs](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/)
- L3: [GitLab REST versioning and pagination](https://docs.gitlab.com/api/rest/)
- L4: [GitLab Issues API](https://docs.gitlab.com/api/issues/)
- L5: [GitLab issue links API](https://docs.gitlab.com/api/issue_links/)
- L6: [GitLab epic/work-item migration](https://docs.gitlab.com/api/graphql/epic_work_items_api_migration_guide/)
- L7: [GitLab Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- L8: [GitLab approval API](https://docs.gitlab.com/api/merge_request_approvals/)
- L9: [GitLab Discussions API](https://docs.gitlab.com/api/discussions/)
- L10: [GitLab auto-merge](https://docs.gitlab.com/user/project/merge_requests/auto_merge/)
