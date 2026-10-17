# Managed desktop P2 source import and acceptance isolation

Date: 2026-10-16. Scope: approved ADR-0233 P2. Status: implementation complete;
guest exact-image verification passed; complete native Host qualification remains pending. Production remains dormant on the backend,
API and UI axes. Dev integration/merge remains paused. Rust tests are skipped at
the user's request; native compilation and Python/Node fixtures are separate
checks, not substitutes for those tests.

## Source authority and execution boundaries

Manifest v2 adds `sourceTreeSha256`, `sourceFileCount`, and `sourceBytes`.
Both Host delivery routes resolve the selected commit, then enumerate regular
Git blobs and hash raw bytes with the shared canonical source-tree contract.
Paths use length-framed raw bytes, including non-UTF8 Linux names; executable
bits and content hashes are included. Checkout filters do not participate.
Symlinks, gitlinks, conflicting paths and oversized input are refused.

The fixed native Host handoff client connects only to the root-owned supervisor
socket. The supervisor retains the authenticated request and lifetime, while a
direct worker receives bounded bytes. Git runs as UID 1001 in a separate strict
boundary after observation of its actual interpreter process. The interpreter
performs fixed no-route checks before opening source input. Root never runs Git,
extracts source archives or executes project content outside confinement.

Promotion waits for the importer namespace init to disappear, opens entries
relative to pinned directories with `openat2` no-follow/no-mount-transition
resolution, copies ordinary files into new root-owned staging, and recomputes
the Host proof. It rejects hardlinks, symlinks, special files, privilege bits,
capability attributes and unexpected acceptance files. The copy is atomically
renamed without replacement. The operation parent is root-owned; the source
subtree is writable by the desktop UID, while acceptance files stay read-only.
Protected requests/receipts remain outside workload mounts.

The importer output and Git metadata share a bounded 2 GiB staging allowance;
this can reject a source tree below the raw 2 GiB proof maximum if its Git
history plus checkout exceeds the staging limit. Promotion permits the separate
32 MiB acceptance allowance. Before parsing, free-space admission reserves room
for two maximum trees and transfer overhead (approximately 4.7 GiB). No silent
truncation or best-effort partial import is allowed.

Acceptance pins the current desktop generation, joins all six namespaces using
its pidfd, restores the pinned confined root, clears groups/capabilities and
installs mandatory seccomp before forking the actual workload. A pre-exec
barrier lets the supervisor verify that child's namespace, identity, root/cwd
and descriptor inventory. Only fixed npm arguments are permitted. Jobs remain
owned after the initial process exits because detached descendants may remain.
Failure, cancellation or deadline terminates the entire pinned generation.

## Verification record

- Host Linux compilation succeeded: [run 38876863886](https://github.com/MaxQian888/cognia-next/actions/runs/38876863886), temporary CI source `0618100bae`.
- Local importer fixtures: 15 passed, including raw attributes, corrupt bundle,
  altered proof, hardlink handling, path rejection and fixed network checks.
- Image contract fixtures: 9 passed. Local startup/auth fixtures: 8 passed;
  3 Linux-only listener checks were skipped locally.
- Rust architecture gate passed for 67 crates with 2 existing baselined findings
  and the existing app-shell size advisory. No full suite or coverage was run.
- Linux image attempt [38877441229](https://github.com/MaxQian888/cognia-next/actions/runs/38877441229) failed in a fixture: live Git publication briefly creates a hardlink. The monitor now permits this transient state only while Git runs; final importer checks and native promotion still reject any surviving link. A regression fixture covers both states.

The temporary image branch contains CI-only job selection. Those changes must
never enter dev; the primary worktree only adds the targeted importer fixture
step to the existing managed image job.

## Exact-image evidence and remaining qualification

Recipe 5 first image `sha256:7ef8f06ff64aae223a8a69d4d2c2f10d2876cca56068b7e47e6788169bcf5b40`
was built by [run 38877862561](https://github.com/MaxQian888/cognia-next/actions/runs/38877862561)
from temporary CI source `445fbb161`. Native static Linux compilation and all
15 Linux importer fixtures passed. Three pre-existing Rust warnings remain;
the new unused accessor warning was removed in the final image build.

| Real-provider assertion    | Observation                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source binding/promotion   | Receipt v2 matched the independent synthetic Host manifest, commit, tree digest, 5 files / 2153 bytes and supervisor generation. `$Id$` bytes were unchanged despite committed checkout attributes. |
| Actual importer            | Root observation captured UID/GID 1001, empty supplementary groups, all five capability sets zero, NNP 1 and seccomp 2 in its separate namespaces.                                                  |
| Acceptance boundary        | UID/GID 1000, empty groups, all capability sets zero, NNP 1, seccomp 2; all six namespace IDs matched the desktop. Only stdio `/dev/null` descriptors remained in the acceptance probe.             |
| Network                    | All 21 TCP 80/443 and UDP 443 attempts to MMDS, mapped IPv6 and private IPv4/IPv6 addresses returned ENETUNREACH.                                                                                   |
| Preview                    | A command entered through authenticated GUI input in the actual desktop terminal fetched `cognia-p2-loopback-only` from acceptance loopback port 8765.                                              |
| Escape/privilege           | `unshare` returned EPERM, restoring UID 0 returned EINVAL; protected control/provider paths were invisible.                                                                                         |
| Promotion permissions      | Operation root 0:0 mode 0711; project 1000:1000 mode 0755; acceptance directories 0:0 mode 0555/files 0444. Protected receipt root-owned 0600.                                                      |
| Supervisor death           | SIGKILL removed all 23 observed workload processes, including the fixture's setsid/double-fork descendant; port 8000 returned ECONNREFUSED.                                                         |
| Wrong source proof         | Correct bundle/commit with altered tree digest failed; no promoted workspace or receipt; generation shut down.                                                                                      |
| Live importer cancellation | Killed the still-live native forwarder while the actual importer was observed. All 20 observed processes disappeared; no new receipt; ingress closed.                                               |
| Acceptance deadline        | A 15-second request deadline stopped all 23 observed processes and ingress, without waiting for provider TTL.                                                                                       |
| GUI                        | Authenticated screenshot decoded as 1280x800 with Chromium and terminal visible.                                                                                                                    |

One initial cancellation diagnostic targeted the very short-lived Git command
and missed it. The forwarder had completed before cancellation; the resulting
survivors were expected and **not a pass or a product failure**. That desktop
was deleted; the repeated trigger used the observed live importer and passed.
Five desktops and the first template were deleted with 204 followed by GET 404;
the scoped running/paused listing was empty. The 120-second per-desktop maximum
bounds that batch's compute at US$0.02760 at US$0.1656/hour; template charges are
separate and this is an upper bound, not an invoice.

The provider diagnostic exercised the compiled guest's real protected handoff
protocol with a synthetic Host-generated frame. Host Rust preparation was
compiled but its unit tests and native Host-to-provider end-to-end path were
not executed in this P2 run. Native copier rejection fixtures are written but
not run under the explicit Rust-test exclusion. These limits must remain
visible in qualification decisions. P3
versioned Host qualification and P4 complete lifecycle/control qualification
remain later gates regardless of this P2 result. No production receipt may be
installed from diagnostic output.

## Final image and cleanup

The final recipe 5 image is
`ghcr.io/maxqian888/cognia-managed-desktop@sha256:e782469a0310164b7bebfef1e06bfdb1328a6edcf76d2730ceaf7b57a09ed545`.
[Run 38879744135](https://github.com/MaxQian888/cognia-next/actions/runs/38879744135)
built it from temporary CI source `110c9c13a`; the only runtime-source change
from the first verified image removes an unused PID field/accessor. Native
compilation, 15 Linux importer fixtures and 9 Node contract checks passed.

The final E2B template was `63o28pn9zgvl3mz5d8tb`, exact build
`b5352870-3a38-4e75-8090-4640ff659250`. The final run again verified the protected
receipt, actual importer, acceptance identity, all six desktop namespace IDs,
21 ENETUNREACH results and absence of privileged inherited descriptors.
Chromium visibly rendered `cognia-p2-loopback-only` from `127.0.0.1:8765` in a
decoded 1280x800 screenshot. Cancelling the live importer removed all 26 observed
processes, including existing acceptance descendants, and closed port 8000;
no cancelled-operation receipt was created.

The first final-image attempt completed handoff but its immediate WebSocket
handshake timed out. It was deleted and recorded as incomplete, not passed.
The repeated diagnostic waited for authenticated `/cognia/health` readiness
before GUI use, matching the production Host's readiness ordering. A diagnostic
`ctrl+l` input returned `Unknown key: ctrl+l`; it is not counted as successful
control. The initially focused address field accepted the URL through the
successful text/Enter operations, and the screenshot independently confirms
the browser preview. This does not replace full control-lease qualification.

All **7 desktops and 2 templates** from P2 were deleted with HTTP 204 and a
subsequent GET 404. The final metadata-scoped running/paused list was empty.
Every desktop had a 120-second native kill TTL, `autoPause:false`,
`autoResume.enabled:false`, provider egress Off and private authenticated ingress.
At US$0.1656/hour, the maximum aggregate desktop compute is US$0.03864;
actual billing and template charges are separate. No production qualification
receipt was installed, no dev merge occurred, and no Rust test/full suite or
coverage command was run.

Private Host evidence is retained under the existing managed-desktop smoke
root: `mmds-p2-final-verified-{handoff,probe,cancel,summary}.json`,
`mmds-p2-final-preview.png`, `mmds-p2-final-cleanup.json`, and the build logs.
The diagnostic frame uses synthetic source, not a user's repository. Provider
credentials stayed on the Host and were not placed in the image, template,
workload, report or CI.
