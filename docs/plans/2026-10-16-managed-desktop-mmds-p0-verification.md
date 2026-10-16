# Managed desktop MMDS isolation: E2B capability verification

Date: 2026-10-16. Scope: P0 capability diagnostic, not product qualification.
The user approved the workload/control-plane distinction and implementation on
2026-10-16. Both ADR-0228 locales now record that decision. Rust tests remain
skipped, the dev merge is paused, and all production enablement remains dormant.

## The provider kernel supports the required primitives

The diagnostic used the previously digest-verified recipe 3 image,
`ghcr.io/maxqian888/cognia-managed-desktop@sha256:694b3de98d68606e9059f742fa376d96d06fa5ce5155eb7ff63b6a4b2f9c56f2`,
registered as temporary template `dot5a21qy7ea17q2uh3w`, exact build
`616906d3-d679-4505-8261-6a998a8d2ca5`. No project source was admitted. The
diagnostic could not install lifecycle/control qualification receipts.

Observed kernel: Linux `6.1.158+`, x86_64. Separate mount, IPC, UTS, network,
PID and user namespace operations succeeded; combined mount/IPC/UTS/network/PID
creation also succeeded. Bubblewrap was absent in this image, so these checks
used a fixed diagnostic through authenticated envd, not the new production guard.

A second successful diagnostic established the following in an isolated process:

| Check                         | Observation                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Identity                      | UID1000, no supplementary groups                                                                             |
| Privileges                    | Permitted, effective, bounding and ambient capabilities all zero; `NoNewPrivs=1`                             |
| Seccomp                       | `Seccomp=2`; a fixed sentinel syscall and later namespace creation returned EPERM                            |
| Mount/PID capability          | Private proc filesystem mounted successfully and observed namespace PID1                                     |
| Network                       | Only loopback, network namespace differs from parent                                                         |
| MMDS direct transport         | TCP80, TCP443, UDP443 and IPv4-mapped IPv6 to `169.254.169.254` all returned ENETUNREACH                     |
| Positive local preview        | Loopback TCP exchanged expected bytes                                                                        |
| Fixed GUI transport primitive | Uvicorn0.54.0 accepted a pre-opened AF_UNIX listener and returned HTTP200 from outside the network namespace |

No metadata token or body was requested. The transport checks attempted only
connections. This proves feasibility of the primitives in the observed kernel,
not confinement of browser/Git/acceptance launch paths or absence of escape paths
in the eventual guard. Exact Bubblewrap setup, mandatory full filter, descriptor
sanitation, GUI compatibility and supervisor-death cleanup still require the
recipe 4 image verification. Historical failed metadata qualification is intact.

## Diagnostic transport failures were not counted as isolation results

Six desktops were created serially, each with private ingress, deny-all IPv4
provider policy, `autoPause=false`, `autoResume=false`, and a 120-second timeout.
Provider inspection observed `onTimeout=kill`. This run did not wait for natural
expiry and therefore does not add native TTL-kill qualification.

The first desktop supplied namespace capability evidence. Four intervening
attempts failed at transport/readiness and supplied no runtime isolation proof.
The interactive diagnostic helper captured the first resource binding; subsequent
health requests used the current resource while process calls reached a deleted
resource. The corrected helper takes the current sandbox explicitly. A health
response of HTTP204 was also identified as valid; it was initially expected to
be HTTP200. The sixth desktop completed the runtime diagnostic with exit0 and
empty stderr. These harness corrections do not relax any product gate.

## All diagnostic resources were deleted

Each ID below had DELETE204 followed by GET404:

- `i4gxb25fkvhgolbpsv69t`
- `i4m4c4f7neqxdmf1x5qqv`
- `i62gu1pp859iwgqm21acg`
- `iq7tjm03cb8lcviwm6z7n`
- `idmau2jb4k6a3s84um4p0`
- `ibs4p0sjrfda01zqi4v8z`

At `2026-10-16T07:28:15.475Z`, the template had DELETE204/GET404 and the
Host/purpose-scoped running-and-paused list returned HTTP200 with zero entries.
Provider keys stayed in Host memory and its existing encrypted store; no keys
were included in guest requests, source files or this report.

The selected shape was 2vCPU/4GiB. The [current public price](https://e2b.dev/pricing),
checked 2026-10-16, is USD0.1656/hour for that shape: an estimated compute ceiling
of USD0.00552 per 120-second desktop, or USD0.03312 for these six allocations.
Template preparation charges and subscription fees are separate; this is not an
invoice or a total account spend claim. No subscription changes were made.

Sanitized observations, fixed diagnostic source and cleanup records are retained
in the private isolated Host directory
`~/.local/share/cognia-smoke/managed-desktop-20261016/mmds-p0-*`.
No production configuration or qualification receipt was changed.
