# Managed desktop MMDS P1: exact guest guard verification

Date: 2026-10-16. Status: **P1 desktop boundary verified in E2B; production remains dormant**.

The accepted [ADR-0233](../content/docs/en/adr/0233-a-managed-desktop-accepts-a-delivered-commit.md)
defines workload isolation separately from trusted provider initialization.
[P0](2026-10-16-managed-desktop-mmds-p0-verification.md) established kernel
capabilities. This record tests the compiled supervisor, launcher and fixed
ingress relay in the published image; it does not qualify handoff or install
production receipts.

## Exact artifacts

- Implementation commit: `9b855e28d6e319ea3370939d03172f60ecbfcd47`.
- First image build commit: `34486e35ee01dd03e0cf36beb6fe825597a7b760`.
- [First image workflow](https://github.com/MaxQian888/cognia-next/actions/runs/38870109930): successful native Linux musl guard compilation, nine Node contract tests and image publication. No Rust tests ran.
- First image: `ghcr.io/maxqian888/cognia-managed-desktop@sha256:5d70ae79d5b31a60ca693a5a021c1d10b58d5c28b26f35a0942379e08af8ed9d`.
- Template `om81uqit3udd5rv3k4ib`, build `5eb3f184-f508-4190-a5b3-dee49ea2c367`.
- Chromium configuration correction: integration commit `2af717eca`; image-build commit `f6dad93dc`. The temporary image-build branch changes workflow job selection only and must not merge into dev.
- [Corrected image workflow](https://github.com/MaxQian888/cognia-next/actions/runs/38871822503): successful compilation, contract tests and publication.
- Corrected image: `ghcr.io/maxqian888/cognia-managed-desktop@sha256:89986f17e48aa33b9c65f815ab0e2b9c539a945ee571822a7da602256c0b2298`.
- Corrected template `x4jdcpbzgnx38wutgkzn`, build `7c64dd1e-e9cc-42f1-86b0-d29932469ba1`.

## First image observations

The Host started `/usr/local/bin/cognia-desktop --managed` over authenticated
envd. The per-session guest token was passed in the process environment, never
argv or persisted in a template. Provider create requested private ingress,
egress Off, 120-second timeout, no auto-pause and no auto-resume.

1. Desktop `iydyagnoe3b72jwvevhef` created a protected generation-bound state.
   Authenticated `/cognia/health` returned HTTP 200 and recipe `4`.
   Root-side observations found the computer-server, Xvfb, D-Bus, Openbox,
   xterm and terminal shell inside the same private network namespace. Each
   workload process had UID/GID 1000, zero capability bounding/effective sets,
   no-new-privileges and seccomp mode 2. The network had only `lo` and no IPv4
   routes. The relay remained outside, UID 65534 with zero capabilities and a
   fixed listener. The terminal and GUI children did not inherit the server's
   Unix listener. Killing the root supervisor with SIGKILL left no live
   observed descendant after one second, and TCP 8000 refused connections.
2. Desktop `io9fnhipa8ohupksph3to` accepted authenticated computer-server click,
   type and Enter commands. Those commands ran a probe in the actual xterm
   shell, rather than root envd or a partial namespace join. The terminal
   process observed UID/GID 1000, empty supplementary groups, all capability
   sets zero, no-new-privileges and seccomp. MMDS IPv4, IPv4-mapped IPv6 and
   `10.0.0.1` TCP 80/443 and UDP 443 connects returned ENETUNREACH. Loopback
   connected successfully. `unshare(CLONE_NEWNET)` returned EPERM. The private
   `/run` did not expose the supervisor control directory. The initial IPv6
   link-local probe lacked a scope identifier and returned EINVAL: **that is
   invalid test input, not isolation evidence**, and the corrected probe adds
   the loopback interface scope plus an IPv6 ULA target.

No MMDS response body or metadata token was requested or collected. These are
bounded transport diagnostics, not an exhaustive port scan or a substitute for
the kernel no-route invariant and later complete qualification.

## Browser failure and correction

Chromium was absent in the first process snapshot. Re-running its launcher
from the actual confined terminal produced:

```text
/usr/bin/chromium: 77: .: cannot open /etc/chromium.d/*: No such file
```

The strict mount allowlist omitted Debian's image-owned browser configuration.
The correction adds only a read-only `/etc/chromium.d` binding and an in-file
profile regression assertion. It does not expose all of `/etc`, add networking,
remove seccomp or grant capabilities. The corrected published image must pass
again without patching guest files or bypassing its launcher.

## Cleanup and validation boundaries

The corrected image was used unchanged in desktops `iw0jfwmuzm2gbqaq9d6uh`
and `ijx836mriwuxpsgco8cmo`. The first verified the browser, authentication,
screenshot and seven Linux Python listener tests. Its diagnostic click landed
below xterm, so no workload probe result was produced; it was deleted and is
not recorded as workload-isolation success. The second used the observed
terminal position and completed the workload and death checks.

The final diagnostic assertions passed:

- HTTP without provider credentials returned 403; provider credentials alone
  returned 401; adding browser Origin still returned 401; both native credentials
  returned 200 with the expected recipe identity. WebSocket challenges returned
  403 and 401 before authenticated input was sent.
- A screenshot was decoded and visually inspected at 1280×800. Chromium and
  xterm were visible; the browser launcher needed no guest modification.
- All 18 root-observed processes in the desktop network namespace, including
  Chromium, crash handlers and the actual terminal probe, had UID/GID 1000,
  empty supplementary groups, all five capability sets zero, NNP 1 and seccomp 2. The terminal probe held only its three PTY descriptors. No child inherited
  the authenticated server's Unix listener.
- All 21 TCP/UDP connects to MMDS IPv4, IPv4-mapped MMDS IPv6, the three private
  IPv4 ranges, IPv6 ULA and scoped IPv6 link-local returned ENETUNREACH. Loopback
  connected. Namespace creation returned EPERM. Restoring UID 0 failed with
  EINVAL because UID 0 is not mapped in this user namespace.
- The real terminal could not open the protected computer-server process's
  `environ` or `mem`: both returned EACCES. No credential contents were read.
- SIGKILL of the supervisor left no live observed descendant after one second,
  including the terminal probe and browser processes; TCP 8000 returned
  ECONNREFUSED. These checks ran before the provider DELETE.

Seven Python server/listener tests passed in the exact Linux image, including
the three Linux-only descriptor cases skipped on macOS. Rust tests remained
skipped. The private `mmds-p1-verified-summary.json` is explicitly marked
`diagnostic-only-not-production-qualification`; it is not a smoke receipt and
cannot enable the provider.

Both first-image desktops were deleted (204) and confirmed absent (404).
The first template was deleted (204) and confirmed absent (404). Private raw
evidence is in the existing isolated Host smoke directory; no credential or
account token is included in this report or committed evidence.

Both corrected-image desktops and their template were also deleted (204) and
confirmed absent (404). At `2026-10-16T08:18:13.476Z`, the running/paused list
for this diagnostic scope returned 200 with an empty array. All four P1
desktops used a 120-second provider timeout. At the checked 2-CPU/4-GiB rate
of USD 0.1656/hour, their combined maximum compute cost was USD 0.02208;
template charges are separate. No TTL was silently extended. Natural TTL
expiry and the native lifecycle/control receipts remain P4 checks.

The temporary stale workflow dispatch `38871739081` was cancelled after its
source revision was found unchanged; only the corrected exact revision is
eligible for the next diagnostic. The dev merge remains paused.

Rust tests remain skipped at the user's request. P2 source/import confinement,
P3 versioned Host qualification and P4 complete native lifecycle/control smoke
remain required; no current result enables the provider on any product axis.
