# Built-in Linux desktop

`cognia-cua-desktop:0.3.46-1` is built locally from these embedded resources on
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

Build: `docker build -t cognia-cua-desktop:0.3.46-1 .`

Sources verified 2026-10-03:

- https://pypi.org/project/cua-computer-server/0.3.46/
- https://github.com/docker-library/python
