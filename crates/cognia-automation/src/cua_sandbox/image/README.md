# Built-in Linux desktop

`cognia-cua-desktop:0.3.46-2` is built locally from these embedded resources on
first provisioning. The pinned multi-platform Python 3.12 base supports native
arm64 and amd64 builds. Debian installs Openbox, Xvfb, a terminal and Chromium;
the official `cua-computer-server[linux]==0.3.46` package serves the existing
computer-server API on port 8000.

The image is compatible with the lifecycle's read-only root filesystem,
anonymous `/home/cua` volume, tmpfs runtime directories, dropped capabilities,
non-root `cua` execution channel and loopback-only published port. Chromium's
inner sandbox is disabled because this container policy forbids privilege
escalation; the Docker container remains its isolation boundary.

The native upstream Linux handler supports screenshot and coordinate input.
Its accessibility tree is a placeholder upstream, so this image does not claim
semantic accessibility support. No Driver/spacesd or cloud account is required.

The embedded ASGI wrapper requires `X-Cognia-Sandbox-Token` for every HTTP and
WebSocket request and rejects browser Origin headers. Lifecycle provisioning
generates a per-container 256-bit credential and passes it privately through
`COGNIA_CUA_AUTH_TOKEN`; it is recovered from Docker metadata only by the native
host. The original nondumpable startup process runs the server after removing
the credential from its environment. Desktop applications, DBus and supervised
shell/file commands never receive it. Upstream telemetry is disabled.

The managed E2B entrypoint is explicitly `cognia-desktop --managed`. It requires
the release-packaged `cognia-desktop-guest` guard and invokes its `supervise`
operation; a missing guard is a startup failure, never a Docker-mode fallback.
The guard must establish the strict workload boundary before launching Python
as `cua`, and pass exactly the AF_UNIX stream listener at descriptor 3. Python
validates that descriptor and marks it close-on-exec before starting any GUI
child. All child launches close inherited descriptors; only the original server
process keeps the listener. Managed Uvicorn uses the pre-opened descriptor,
preserving the same HTTP/WebSocket authentication without a TCP listener inside
the workload. The no-argument Docker entrypoint retains its port 8000 listener.

Recipe 5 includes Bubblewrap for the guard's mandatory confinement profile.
Installing Bubblewrap or passing a listener is not isolation attestation: the
native guard and Host qualification must verify namespaces, privilege dropping,
and the actual desktop/import/acceptance paths. The base Docker build alone
does not package that guard and cannot start managed mode. Production managed
desktops remain dormant until the exact release passes native qualification.

Build: `docker build -t cognia-cua-desktop:0.3.46-2 .`

Sources verified 2026-10-03:

- https://pypi.org/project/cua-computer-server/0.3.46/
- https://github.com/docker-library/python

Managed publication compiles `cognia-desktop-guest` for `x86_64-unknown-linux-musl` with the repository toolchain and lockfile. `scripts/build/managed-desktop-context.mjs` verifies a static amd64 ELF and stages a fresh context containing the guard; the Images workflow builds that context. The embedded Docker context stays independently buildable. Recipe 5 readiness checks require both Bubblewrap and the guard before E2B template admission.

Recipe 5 packages the fixed importer as root-owned, read-only image code. Host
handoff invokes `cognia-desktop-guest handoff`; it no longer uploads a Python
program for root execution. The supervisor admits Git only in the separate
UID 1001 importer boundary, then independently hashes a no-follow copy against
the Host-derived manifest v2 source proof. Importer stdout and `.git/HEAD` are
not source authority. Promotion preserves ordinary executable bits but rejects
links, special files and mounted subtrees. Acceptance files remain read-only.

Acceptance starts through the supervisor's generation-pinned desktop boundary,
with the same loopback network and GUI filesystem. The fixed helper closes all
privileged descriptors and drops setup privileges before running the validated
npm script. Cancellation or uncertain launch terminates the entire desktop
generation; project descendants cannot survive by creating another session.
These implementation paths remain dormant until exact-image qualification.

## Selkies variant (ADR-0234 Phase 4)

`selkies/` builds `cognia-cua-desktop:0.3.46-2-selkies-2.0.0` on top of the
built-in image. A sandbox only gets it when the user turns on its Selkies switch
after the licence notice. It is built on first start from the public `selkies==2.0.0`,
`pixelflux==2.1.0` and `pcmflux==2.1.0` wheels. The `pixelflux` wheel bundles GPL
x264, x265 and FFmpeg, so Cognia never publishes this image. The base image, its
recipe 7 and the managed image are unchanged; the variant refuses `--managed`.

`selkies-startup.py` runs the unchanged `startup.main()` in-process and starts
Selkies once `:99` answers:

- **Environment.** Selkies runs with an explicit environment holding only the
  display variables and `SELKIES_MASTER_TOKEN`. The computer-server credential
  never reaches it.
- **Restarts.** The startup restarts Selkies with backoff, at most five times,
  and keeps the desktop running if Selkies gives up.
- **Network.** It listens on container port 8080. Lifecycle publishes that port
  on host loopback only, and passes the master token as
  `COGNIA_SELKIES_MASTER_TOKEN` by name, the same way as the auth token.
- **Fixed flags.** WebSocket mode, H.264 software encoding with JPEG fallback, no
  resize, and `enable_collab=false`. Audio, microphone, webcam, gamepads,
  clipboard, file transfer, printing, command messages, sharing links and the
  second screen are off, and locked where Selkies allows it.

**Access.** The Host is the only writer of the Secure Mode session table. Each
viewer gets a fresh view-only token. A controller token (`mk_control`) goes only
to the viewer holding the control lease, and it is revoked and confirmed gone
before the lease is released or the agent acts.

**Trust boundary.** Inside the container the master token is not a boundary
against code running as `cua`: that code can already reach the X display. It
keeps other processes on the host from using the published port.

Build by hand: `docker build --build-arg BASE_IMAGE=cognia-cua-desktop:0.3.46-2 -t cognia-cua-desktop:0.3.46-2-selkies-2.0.0 selkies`

Sources verified 2026-10-18: https://pypi.org/project/selkies/2.0.0/ ,
https://docs.selkies.io/latest/secure-mode ,
https://github.com/selkies-project/pixelflux/blob/1ebcb0a10a96caeba20e1ad09be47cc018a55238/LICENSES.md
