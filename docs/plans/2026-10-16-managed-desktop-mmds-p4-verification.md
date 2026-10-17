# Managed desktop P4 qualification

Date: 2026-10-17. Status: **complete native P4 qualification passed on the pinned image; production remains dormant**.
Baseline: `1971a0a0fbbda3efac50d690aae820bfe30b5de5`, isolated integration worktree.
Production is dormant; dev merge remains paused. Rust tests and coverage are not run.

## Verified outcome

| Native check               | Final image result                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle                  | Passed: TTL kill/no resume, private ingress/auth, decoded frame, restart deadline and destroy retry                                                       |
| Control takeover           | Passed all 14 assertions, including exclusive lease, explicit transfer, frame/token fencing, live revocation, compound interruption and reopen/quarantine |
| Shared Host authority      | Passed paired-owner, consent, one-shot scope, timeout/cancellation/late approval, admin expiry/revocation and per-send checks                             |
| Workload isolation         | Passed report v2: actual importer/acceptance/terminal/Git/browser, raw transport/DNS, privilege/namespace/FD checks and real weakened-profile rejection   |
| Independent teardown       | Passed: supervisor killed while Host disconnected; 24 observed processes terminated, zero survivors, ingress refused before Host cleanup                  |
| Commit and recovery bundle | Both passed native preparation, confined install, source-tree/receipt binding, reconnect and protected checkpoint; separate operations, same source tree  |
| Qualification composition  | Passed in a fresh native Host process from persisted same-config/template evidence; zero quotes; partial evidence previously refused                      |
| Cleanup                    | All 42 recorded P4 desktops and 7 templates return 404; scoped running/paused inventory is empty; all 41 active-journal desktops are destroyed            |

The complete receipt is bound to config revision 11, image `b17c0899…1cf5a9`,
template `nfgqxzkf2c938t1czh0b`, and binding digest
`96e0d4fbd8ce073b6f4a2b5f11df4124ecb13509b9e5851e4b0481212553b7bb`.
It contains four distinct workload boundaries and two distinct native handoff
receipt digests. Qualification was installed only in the private diagnostic Host.
After cleanup, its active configuration was disabled at revision 12; the qualified
revision-11 input and evidence are archived. Backend/API/UI production enablement
and dev merge remain unchanged and dormant/paused respectively.

The total maximum desktop compute cost for all 42 recorded P4 resources is
US$0.30912 at their approved rate and hard deadlines; the final seven resources
account for US$0.06072. This is a conservative compute ceiling, not an invoice,
and excludes template-build and subscription charges. All failed attempts remain
failed in the evidence history. The initial ENOSPC journal retains its historical
running row, while a fresh provider GET confirms that resource is absent.

## Execution checks

1. Extend the existing native control smoke → verify release/takeover, lease and frame fencing, expiry, live revocation, compound-send interruption and reconnect using actual transport acknowledgements.
2. Exercise shared Host authority, admin leases and consent → verify real paired identity, operation/device scoping, one-shot approval, expiry/revocation and late-approval rejection in a fresh private synthetic Host.
3. Add fixed workload qualification using the existing supervisor/importer/acceptance launch paths → verify raw transport/proc observations, actual browser/terminal/Git/npm paths, weakened-profile rejection, and independent supervisor-death teardown. No caller script/PID/destination is admitted.
4. Compose qualification only from native records → verify exact config/template/owner/Host/generation, unique commit and bundle receipts, matching source tree, all required assertion sets and completed resource cleanup. Old or partial records stay unqualified.
5. Build the exact pinned image and native operator → run narrow tests and explicitly authorized provider smoke; delete every billed desktop/template and verify provider absence. Preserve failures as failures.

## Build and local checks

- Current runtime snapshot: `820d924565e3542bbccc46931de6c58effc219a3`.
  All 35 recorded runtime/build inputs match the isolated implementation worktree
  at `e2415a287`.
  [Image and native Host build 38934225618](https://github.com/MaxQian888/cognia-next/actions/runs/38934225618)
  passed without Rust tests.
  Image: `ghcr.io/maxqian888/cognia-managed-desktop@sha256:b17c089908ea93c24090d80ec39f163a92a2e60d443cfb9ceb2e3eacb81cf5a9`.
  Native binary SHA-256: `7ebf17f6ac4bb18b576e5f75e933675978a3da61d2acba144f9ebad45caee3db`.
  Archive SHA-256: `783ffa2f3fa8880934d95b03c4b2fc1767b426172fbaba746c873367861ffa6d`,
  verified against GitHub artifact metadata. The release archive was independently
  checked against `27988079267da271bedcbee61653f6813dcc3e69bfdacb97fb0f9881a8817d54`.
- Current source checks: 90 closed diagnostic stages agree between collector and
  Host; changed Rust sources parse successfully and locked offline dependency
  metadata resolves. The browser-denial regression definitions were reviewed but
  not run. The latest release/context tests passed 9/9 and importer fixtures 17/17.
  No Rust tests ran.

Earlier builds and attempts are retained below rather than substituted for current
exact-image qualification:

- Runtime snapshot: `0f9c7c9a7dee03cdb079dae5268bd21ff4897abf`.
- [Exact image/native Host build](https://github.com/MaxQian888/cognia-next/actions/runs/38909060809): passed, no Rust tests.
- Image: `ghcr.io/maxqian888/cognia-managed-desktop@sha256:855638739d6611289ca792eb36473fdc7c9f3a9065f37c652d93c37d1ffa6d6b`.
- Native macOS operator SHA-256: `23624ac12a79b0407fd3e5154c09fbadf7f6e4584a9a9c54b36235752cc5388b`.
- Official operator archive SHA-256: `315665e0fe5d375691696c405dbb157954400cbcc1ed2b9f85c841f1aceba2a3`, checked against GitHub artifact metadata.
- Release/context Node checks: 9 passed. Python import fixtures: 17 passed. Local server checks: 4 passed, 3 dependency-dependent checks skipped. Rust source parsing and scoped whitespace checks passed.
- Native qualification with missing evidence refused before any quote or paid resource.
- After real lifecycle and Host-authority success on image 3, native completion
  still refused `managed_desktop_qualification_invalid` with zero quotes because
  required control/workload/handoff evidence was incomplete.
- Initial planned desktop compute ceiling: six 120-second resources and one 240-second resource, US$0.04416 at the recorded shape rate. Template-build charges are separate. Additional attempts must be recorded separately.

## Provider attempts (2026-10-16)

All attempts use the owner's explicit paid-smoke authorization and a digest-pinned
recipe-7 image. A failed attempt never installs qualification. Status language in
this chronological record describes each checkpoint at that time; the final
outcome table above records the completed exact-image result.

- Initial disk-backed lifecycle: TTL deletion was observed, then journal persistence
  failed with `managed_desktop_storage_unavailable` during local ENOSPC. The desktop
  and its template were independently confirmed absent at the provider. The failed
  journal is preserved; it is not rewritten to claim successful recovery.
- RAM-backed lifecycle retry: the second desktop returned
  `managed_desktop_provider_unknown_outcome`; both desktops were cleaned up. The
  cause is not established. An unchanged rerun passed native expiry kill, no auto
  resume, delete retry, service journal reopen/deadline and decoded-frame checks.
- Initial control: rejected a stale frame. The harness reused a frame across
  negative remote authority checks. Its fix renews and captures immediately before
  positive input; the five-second frame limit is unchanged. Retry pending.
- Initial authority: rejected an expired control lease. Each independent consent
  case now renews and captures independently. Real consent/admin expiry checks are
  unchanged. Retry pending.
- Initial workload: rejected as qualification unavailable. A retry with bounded
  collector-stage diagnostics identified acceptance qualification; importer
  collection completed. Early-worker failure reporting and the diagnostic-only
  report wait were fixed; production limits and required observations are unchanged.
  Full isolation qualification remains unproven.
- Initial commit handoff: source preparation and paid create succeeded, then transfer
  failed. A bounded transport/protocol/guest-exit diagnostic was added. A fresh
  operation retry passed transfer, reconnect, protected receipt and checkpoint.
  The original transfer failure's cause is not established.
- Control retry with a fresh frame reached `first_positive_fresh_input` but was
  quarantined without acknowledged completion. Static outcome/timing diagnostics
  were added; no deadline, authority check or quarantine rule was relaxed.
- Authority retry acknowledged positive input and all required denials except
  compound revocation. That case recorded zero admitted/denied commands and remains
  failed; exact refusal diagnostics were added before further testing.
- Rebuilt image `sha256:92aebb571f06cca33aa10c9b7d0fc5cd02323b756035f100d5559cca9c5ee54c`
  from [build 38917602836](https://github.com/MaxQian888/cognia-next/actions/runs/38917602836)
  passed the complete lifecycle diagnostic again. Its workload diagnostic reached
  `payload_terminal_wait`; full qualification remains refused.
- On that image, the control diagnostic measured 4.75 seconds of preparation in
  the five-second frame window and only 249 ms available for an acknowledgement.
  One command was admitted, then the deadline expired and the desktop was correctly
  quarantined. The independent authority fixture reproduced the same issue with
  only 69 ms remaining. Neither attempt is control qualification.
- The latest native Host build at this checkpoint is
  [38918486241](https://github.com/MaxQian888/cognia-next/actions/runs/38918486241),
  source `6ec658553754237882fb1e2633036b46bd91ba51`, binary SHA-256
  `b8db7e975b7da2a400a13cdc3c3454f550857053e721daf7a0abb2681cb1ea2f`.
  Compilation passed without Rust tests.
- The subsequent exact-image build is
  [38921210486](https://github.com/MaxQian888/cognia-next/actions/runs/38921210486),
  source `9c18235fa85d52f08e6cb4964c4bef68fd61e09f`. Image
  `sha256:c36ab2bb3a18bc40eecc72e91da91fd4de13c5fb47d5f034fb51fd34708552a6`
  contains the terminal protocol and bounded-probe fixes; native Host validation
  includes the input admission optimization. Both builds passed without Rust tests.
  Native binary SHA-256 is
  `364bc503f33a85e03b6706426fdbc1529d9687b9d0c0112ef0593c7257ca3b01`;
  archive SHA-256 is
  `922d5785c9f585b5396c19b0ec7b057d7e752369df4f95b87c3f669b41b5274b`.
  Lifecycle passed again; remaining provider qualification is in progress.
- On image `c36ab2bb…52a6`, the complete native Host authority smoke passed:
  positive input was acknowledged; consent/admin violations and late approval were
  rejected; compound input admitted one command and denied the second after live
  revocation. Its measured send budget was 2582 ms, with unchanged five-second
  frame expiry. The desktop was deleted and scoped inventory was empty.
- The same image still failed workload qualification at the importer stage after
  introducing the two-second resolver wait. That timing hypothesis is unproven;
  fixed child failure detail and revised bounded scheduling are being prepared.
  One control attempt separately refused a live-boundary observation before input;
  the failure is retained. An unchanged retry acknowledged input and rejected an
  expired frame, then reached the next takeover case with an expired lease. The
  harness now renews before the deliberate frame-expiry wait and quotes a separate
  240-second diagnostic desktop for the complete sequence.
- After every failed provider run above, the owner/Host-scoped running/paused desktop
  inventory was checked and empty. The first retry template was also deleted and
  independently confirmed absent before switching to the rebuilt image.
- Image `sha256:55c108a365bd54ef73b2242a7c62bd447aafeeef2185623bbac93fb3b64a4569`
  and native Host compiled in [build 38924279330](https://github.com/MaxQian888/cognia-next/actions/runs/38924279330).
  Its lifecycle attempt hit the existing 900-second OCI verification deadline on
  layer 3, before any quote approval or paid create. Layer log sizes are descriptor
  sizes, not byte-progress counters; the exact transfer failure is not established.
  At `2026-10-16T15:48:38Z`, the attempt was recorded as failed. No template was created.
- [Native build 38925292654](https://github.com/MaxQian888/cognia-next/actions/runs/38925292654)
  passed without Rust tests, source `e22db9e81268311f2c2f60135ffb1e1190082422`.
  Its binary SHA-256 is `aba4575d3ffe98f4399d69d74a708cc99f4d3b4ebecce5f88bb2dc22fbc9132d`;
  archive SHA-256 `ecd4139d6a5cc56614aca0a05fba315e5d38427858d226e9c05586ca53522f74`
  matches the GitHub artifact metadata. Revocation checks now prove the lease was
  still live, preventing expiry from masquerading as successful revocation fencing.
- Image `04966c71…55f05a` passed complete native lifecycle verification and both
  lifecycle desktops were destroyed. The subsequent workload run refused at
  `validation_browser`, after the version-2 weakened-profile and preceding
  transport/privilege validations. This is partial diagnostic progress, not
  workload qualification. The browser assertion still combined executable,
  Git exit, local-preview and network-error checks; its exact cause is unproven.
- The same image's control run refused `transferred_frame_still_fresh` after
  82111 ms. Remote reacquisition includes boundary and screenshot observations
  and can outlive the old frame's five-second window. The harness must prove
  release invalidation while the old frame/lease are live, before reacquisition,
  then independently prove old-frame absence and new-controller input.
  Both failed diagnostic desktops were destroyed and scoped inventories were empty.
- The image-5 commit handoff completed transfer but exceeded its 120-second
  diagnostic deadline during reconnect. The provider confirmed absence; its
  local destroy-retry record is retained pending native reconciliation. Fresh,
  independently quoted 240-second commit and recovery-bundle operations both
  passed native source preparation, confined install, journal reconnect, receipt
  binding and protected checkpoint storage. No verdict or task completion was invented.
  All seven image-5 desktops were absent at the provider. Template
  `ea26pu3576fjfokyf7q9` was deleted (204) and confirmed absent (404).

The next snapshot `6cd1e62c045c31d3fad03ecdcc90db66501d268c` preserves browser
acceptance requirements and adds bounded, typed, generation-matched failure
diagnostics. It also proves release invalidation before slow remote reacquisition.
Independent source review found no blocker; current-image smoke is still required.
Its [build 38929674220](https://github.com/MaxQian888/cognia-next/actions/runs/38929674220)
passed Linux guest/image and native Host compilation without Rust tests. Image
`sha256:88c9ecf96dde650d35d3d781f846642d65eeb6dae0147b679fb26021dcb597b8`
contains those diagnostics. Native binary SHA-256 is
`401ea9ddbc74404c15bb6e49f72b9c017f808f0ffa8e850304e95c1858448c17`;
the downloaded archive matched GitHub's
`bbe2c7ec8ae9e2893487fc908c38d9c5f5741c1b9cc45dcecde364d9d820925c`.
The release archive matched
`853bd0557c4b4a3731b109815107b9839279c381761863d4dc98b890915b9134`.
Its first lifecycle attempt timed out verifying the 510049959-byte layer, before
any quote or paid creation. The Host-only progress build
[`38931301301`](https://github.com/MaxQian888/cognia-next/actions/runs/38931301301)
passed without Rust tests, source `1fef9cbe08b88a33b0a576cd497dfff4350f449a`.
It reports bounded numeric byte/time progress and verified completion, retaining
the same registry stream, digest/size checks and 900-second overall deadline.
Binary SHA-256: `9c5f427f29de2eaa0df98ccc556cd2ab9a9ef4549cc2fbcd5ab6a656e5602733`;
archive SHA-256 `ed509ff0eb34f06bcb55532a9b1345fa6cf0ac0d5cc471b879d680a5349716bf`
matches GitHub artifact metadata. The unchanged image-6 retry verified every
layer; its 510049959-byte layer completed in 93345 ms. Native lifecycle smoke
then passed, including provider timeout kill, no automatic resume, destroy retry,
journal reopen and decoded-frame checks. After completion, the scoped provider
inventory returned HTTP 200 with zero running or paused desktops.

On image 6, workload qualification identified the precise browser mismatch:
all executable identities, Git exit, browser exit and local preview passed;
direct metadata, redirected metadata and hostname navigations each returned
Chromium `ERR_INTERNET_DISCONNECTED` (`-106`). The prior validator expected only
`ERR_ADDRESS_UNREACHABLE` (`-109`) or `ERR_NAME_NOT_RESOLVED` (`-105`). The
attempt remains failed and its desktop was deleted. Chromium's loopback-only
network classification and error normalization were confirmed in upstream source.
The correction admits only nonempty, target-specific sets of denial codes
(metadata/redirect: -109 or -106; hostname: -105 or -106). Success, abort,
timeout, refusal and other mixed codes still fail. Mandatory raw kernel
socket/DNS, privilege, namespace, FD, positive-loopback and teardown requirements
remain unchanged. Independent review found no boundary waiver. The source check
used Chromium main on 2026-10-17; the image's exact Chromium package/source version
was not established. The runtime observations above remain image-digest-bound.

The same image passed the complete native control qualification, evidence version
2, with all 14 assertions: authenticated transport/frame, exclusive controller,
explicit takeover, release/transfer, token/frame fencing, single-use and expired
frames, lease expiry, live authority/principal revocation, compound-send
interruption, service reopen, persistent quarantine and refusal of dormant agent
delegation. Provider inventory was HTTP 200 with zero running/paused desktops
after cleanup. This is control evidence, not full workload qualification. Native composition
refused the partial record with `managed_desktop_qualification_invalid` and zero
quotes. Template `kcewz7tmchy6ttnd4q7r` was subsequently deleted (204), confirmed
absent (404), and scoped running/paused inventory remained empty.

Image 7 includes the reviewed browser error classification. Its first lifecycle
invocation refused `managed_desktop_release_unavailable` with zero quotes because
the private Host catalog still pinned image 6. The catalog was aligned with the
verified image-7 release artifact before retrying; no version fallback was used.
Native lifecycle reconciliation also cleared the earlier image-5 destroy-retry
record: all 34 desktops in the active journal were destroyed before image-7 smoke.

The image-7 lifecycle retry verified all 13 OCI layers, registered exact template
`nfgqxzkf2c938t1czh0b` (build `4cf0be84-bff7-45ee-9689-4889ee979358`),
and passed native TTL kill/no-resume, ingress/authentication, decoded frame,
restart deadline and destroy-retry checks. Both desktops were destroyed and scoped
inventory returned HTTP 200 with no running/paused resources.

The same image passed complete workload report version 2: the actual data-free
`importer-without-seccomp-v1` negative profile was rejected and terminated;
all required process, privilege, namespace, descriptor, socket, DNS and protected
path checks passed. Chromium rendered the positive loopback marker and recorded
URL-correlated `-106` denials for direct MMDS, redirected MMDS and hostname
navigation. During the disconnected interval, the independent collector killed
the pinned supervisor; 24 observed processes were terminated, none survived,
and ingress returned connection-refused (`errno 111`) before Host deletion.
The Host journal records the smoke desktop destroyed and provider GET returned 404. This is actual workload evidence. The same-image control run subsequently
passed all 14 assertions, including one admitted and one denied compound command
on live revocation. Fixed-commit and recovery-bundle native handoffs also passed,
using distinct operations and protected receipt-version-3 records for source tree
`b7e27434bd7772a0ea53727fa38afdfbab28c2e33a92377d8b3b8dd29072eabb`.
Both verified confined importer/acceptance boundaries, service reopen/reconnect,
private checkpoint storage and completed deletion; `executionEnabled` remained
false. Scoped provider inventories were empty after each completed run.
The same-image shared Host authority diagnostic then passed all required
assertions, including one admitted and one denied compound command after
revocation. Native `complete-qualification` succeeded from persisted evidence
without another quote. The final template was deleted (204) and confirmed absent
(404), followed by independent absence checks for all recorded P4 resources.

The retry Host lives on a private RAM-backed filesystem because the local disk
reached ENOSPC. Journal close/reopen exercises service restart semantics; this is
not an OS reboot or power-loss durability result. Small evidence files are copied
to private disk storage, with credentials retained only in the encrypted Host store.

## Review fixes

A new authorized native diagnostic now invalidates that category's earlier record
and any composed qualification before paid create. Failure cannot silently fall
back to old success. Lifecycle, control, authority, workload, commit and bundle
categories retain each other's evidence and preserve resource cleanup history.
Co-located regression definitions cover administrator admission, category removal,
retention of independent evidence and inability to recompose after invalidation.
These Rust tests have not been run under the user's validation constraint.

The measured control deadline failure led to a targeted admission change: input
entry now checks local authority, configuration, qualification and quarantine;
the final remote boundary observation still runs after screenshot capture and
before sending. Post-ACK live observation and per-command fences remain intact.
The frame and lease deadlines are unchanged. A regression definition requires a
missing boundary to be rejected after capture with no input delivered.

The terminal diagnostic now establishes and authenticates its Unix connection
before running the full probe. Fixed exit, deadline and probe failure categories
separate previously conflated causes. Actual libc DNS calls have bounded waits;
a timeout fails qualification rather than inventing a denial. The latest revision
queries both fixed names concurrently under a shared 12-second deadline and runs
all four Chromium navigations concurrently with distinct profiles and evidence.
The existing acceptance and collector deadlines remain authoritative.
The terminal protocol defect is established from code. The final image passed
the actual terminal path; earlier undifferentiated failures are not retroactively
attributed solely to this defect.

The wiring audit found the native operator, fixed envd commands, immutable image
payload, confined launchers and Host-side revalidation connected. It does not
substitute for passing provider observations.

## Evidence boundaries

The private identity fixture exercises shared production authority/consent code,
not the network RPC authentication envelope. Manual human control and explicit
transfer are separate from production acceptance-bound agent delegation, which
remains dormant. Missing required launch or teardown observations block full
qualification; old recipe evidence cannot fill those gaps.

The negative control observes the actual privileged collector outside the workload
boundary and requires workload admission to reject it. The native collector and
Host also reject deterministic mutations of captured capabilities, seccomp,
no-new-privileges, namespace, descriptor and socket evidence. This is executable
authority/validator negative evidence, but does not satisfy the accepted plan's
separate requirement to exercise an intentionally weakened launch profile.
The implementation now adds a fixed, data-free importer diagnostic that must
produce actual kernel evidence of the missing seccomp filter, fail normal admission,
and have its process tree confirmed terminated. Report version 2 makes this raw
evidence mandatory; inherited provider seccomp or any additional boundary defect
refuses the negative control. The production importer continues to require the
complete filter, with no optional production fallback. Independent source review
found no blocking defect; final image-7 execution subsequently verified this
actual weakened-profile rejection and complete termination.

## Sources

- [E2B pricing](https://e2b.dev/pricing), checked 2026-10-16: 2 vCPU + 4 GiB compute US$0.1656/hour, Hobby 1-hour and Pro 24-hour lifetimes. Template and subscription charges are separate.
- [Accepted isolation plan](2026-10-16-managed-desktop-mmds-isolation.md).
- [P3 evidence](2026-10-16-managed-desktop-mmds-p3-verification.md).

- [Chromium Linux interface classification](https://github.com/chromium/chromium/blob/main/net/base/address_tracker_linux.cc#L548-L569), [TCP completion](https://github.com/chromium/chromium/blob/main/net/socket/tcp_socket_posix.cc#L619-L642), and [DNS completion](https://github.com/chromium/chromium/blob/main/net/dns/host_resolver_system_task.cc#L409-L447), checked 2026-10-17: loopback does not establish an online connection; failed TCP/DNS operations can be reported as `ERR_INTERNET_DISCONNECTED`.
