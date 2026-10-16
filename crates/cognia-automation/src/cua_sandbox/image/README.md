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
