# Managed desktop P3: versioned Host boundary and native handoff

Date: 2026-10-16. Status: P3 implementation and native real-provider diagnostics passed; P4 full qualification remains pending.
Production remains dormant on backend/API/UI axes; dev merge remains paused.
Rust tests are explicitly skipped. Compilation and narrow Python/Node/Jest checks
are separate evidence, not substitutes for Rust tests.

## Implemented boundary

- Qualification evidence version 2, guest observation version 1/isolation revision 1,
  exact image recipe 6, protected handoff receipt version 3.
- The Host pins owner/Host/config digest, exact template/build/image, provider resource,
  desktop ID/generation and kernel namespace/process generation. It rejects old,
  missing, replayed or changed observations and retains cleanup/retry authority.
- A fixed root-only guest observer reads bounded protected state and actual kernel
  status/routes/descriptors. No arbitrary PID/path/script is supplied by callers.
- Importer/acceptance admission reports remain separate from live desktop reports;
  the Host independently checks profile and generation correlation around transfer.
  Admission reports do not assert successful socket probes.
- Native handoff closes and reopens the exclusive Host journal, reconnects, compares
  the persisted boundary, captures a private checkpoint, then destroys the desktop.
  Failed reopening still persists cleanupPending and the diagnostic outcome.
- Lifecycle diagnostics preserve actual provider-root network observations separately.
  They do not install production qualification. P4 complete workload/lifecycle/control
  evidence remains required. UI/adapter gates reject missing and unknown versions.

## Narrow local validation

- 8 Jest suites / 170 tests passed (settings, client, lifecycle adapter, capability,
  runtime availability, lifecycle contract, migration and handoff).
- Both locales rendered in tests; i18n generation, freshness, parity and scoped ESLint passed.
- 9 Node image/release checks passed. Added a regression that first reproduced the
  Host loader recipe 3 versus image recipe 5 mismatch; recipe 6 now agrees everywhere.
- 15 Python importer fixtures passed; 4 image server checks passed and 3 Linux-only
  checks were skipped locally.
- Scoped TypeScript compilation reported 22 dependency diagnostics and zero diagnostics
  in changed paths; this is not a clean repository-wide typecheck.
- Rust architecture gate passed (67 layered crates, 2 existing baseline findings;
  existing app-shell LOC advisory remains).
- Independent wiring/security/i18n/test-gap review found no remaining blocker.
- New negative Rust fixtures cover old receipts, changed generation/profile, missing
  observation, identity replay and handoff receipt substitution. They were not run.

## Native verification setup

The CI-only snapshot branch built a native macOS Host operator and static Linux
image without Rust tests. [CI run 38885322707](https://github.com/MaxQian888/cognia-next/actions/runs/38885322707)
passed at source `0974a3cdbc50360687840659dc7ba26def3e5bbb`. The native build took
8 minutes; the static Linux guest build took 36 seconds.

- Native operator SHA-256: `c309c90c7f923ee0445de7540fc29c63f7f369f91bf8aa1c35935545592b7a62`.
- Exact recipe 6 image: `ghcr.io/maxqian888/cognia-managed-desktop@sha256:3e28b31f50517cd9da2184cbf10ad45e017dce6f1565e3b35a0eca8ab86e1d5b`.
- Synthetic fixture commit: `5a40278cab63c73d1ebc2b9a2f75ec7818122d2e`.

A private 4.5 GiB RAM volume supplies temporary source staging because local disk
space fell below the existing 4 GiB admission guard. The guard and actual storage
reservation remain unchanged; this is a diagnostic environment choice.
CI selection changes stay outside the integration worktree.
The fixture is synthetic: its persisted source/delivery records are seeded diagnostic
inputs, not evidence that a real code-task sandbox published them. Native delivery
resolution, read-only Git proxy, source digest derivation, transfer, promotion,
acceptance and restart/reconnect use production code.

The initial planned batch is four sequential 120-second desktops at 2 vCPU / 4 GiB:
maximum compute US$0.02208, with template charges separate. Failed or additional
attempts must be recorded separately. Provider keys stay in the local encrypted
Host store; no credential enters CI, the image or the desktop workload.

## Native real-provider results

All three native operator commands exited 0. There were four desktop creates,
no failed/additional desktop attempt, and one account template build. The desktop
compute upper bound remained US$0.02208; this is a quoted bound, not an invoice.

| Check                    | Observed result                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle                | Native expiry killed the first desktop without Host cleanup; no auto-resume. The second desktop recovered a one-shot delete failure through journal reopen and real deletion before TTL.                                                                                                             |
| Authentication and frame | Unauthorized edge request returned 403; edge-authenticated request without guest authentication returned 401; authenticated protocol/frame checks passed.                                                                                                                                            |
| Provider-root network    | MMDS HTTP response remained observable (`metadata: true`); the other nine fixed targets returned no response. This is separate trusted-control-plane evidence, not workload denial.                                                                                                                  |
| Commit handoff           | Native delivery authorization, read-only Git preparation, Host tree proof, confined import/promotion, acceptance admission, journal reopen/reconnect and encrypted checkpoint succeeded.                                                                                                             |
| Recovery bundle handoff  | The same complete native path succeeded from the recovery bundle and produced the same source proof.                                                                                                                                                                                                 |
| Source proof             | 5 files / 2,449 bytes, SHA-256 `b7e27434bd7772a0ea53727fa38afdfbab28c2e33a92377d8b3b8dd29072eabb`; protected receipt version 3 in both paths.                                                                                                                                                        |
| Observed confinement     | Live desktop and acceptance admission use UID1000; importer admission uses UID1001. Reports show zero capabilities, empty supplementary groups, NNP, seccomp and loopback-only networking. Importer has separate six namespaces; acceptance matches the persisted desktop generation and namespaces. |
| Visible result           | Both integrity-checked private PNG checkpoints show Chromium at `127.0.0.1:8765` displaying `cognia-p3-native-host-handoff`. Each PNG is 16,040 bytes.                                                                                                                                               |
| Result separation        | Both records have system `inconclusive / diagnostic_no_agent_verdict`, no agent verdict, no human approval, and `cleanupPending: false`.                                                                                                                                                             |
| Dormancy                 | Zero production qualifications. Lifecycle evidence is version 2 in the separate diagnostic journal; `workloadEvidence` remains null. Diagnostic config was disabled after smoke.                                                                                                                     |

The runtime source matches the CI snapshot. The integration worktree additionally
contains one unrun Rust negative-test input for storage-reopen failure, plus
frontend/docs changes that are outside the native binary.

### Resource cleanup

At 2026-10-16T10:38:32Z, all four native journal desktop rows were destroyed and
independent provider GETs returned 404:
`imweyfzwur473lkf5fg0a`, `i5bn3wl3qirbidx6r9bpj`,
`i0yezhtbovic8165mtuj4`, `ipjfpax5d7qg0viw15gdn`.
Template `lc2orq8uwxotuw5nqojl` deletion returned 204 and subsequent GET returned 404. The scoped running/paused list returned 200 with zero resources. No operator
process remained; temporary source staging was empty. Private logs, encrypted
checkpoints, build identity and cleanup receipts remain in the operator's private
smoke data directory; no share links were created. The owned RAM volume was
detached after staging was empty, and the in-memory credential reader was reset.

## Evidence limits

The seeded delivery/source fixture does not prove an actual code-task publication.
Journal close/reopen verifies durable state but is not a full OS/Host process
restart. The fixture emitted workload probe files inside the ephemeral desktop;
these were not collected as native qualification evidence. Admission reports and
preview screenshots do not substitute for P4 socket-probe or hostile-process tests.

P3 does not automatically enable production or substitute for full control lease,
takeover, revocation and P4 qualification. Actual application UI was not exercised;
settings rendering was checked with targeted component tests. All diagnostic paid
resources were deleted and absence verified before closing the checkpoint.

## Sources

- [E2B pricing](https://e2b.dev/pricing), checked 2026-10-16: 2 vCPU US$0.000028/s
  plus 4 GiB US$0.000018/s; Hobby 1 hour and Pro 24 hours.
- [E2B sandbox lifetime](https://docs.e2b.dev/faq/sandbox-lifetime), checked 2026-10-16:
  kill is distinct from pause/auto-resume. Native diagnostics retain explicit kill settings.
- [P2 evidence](2026-10-16-managed-desktop-mmds-p2-verification.md).
