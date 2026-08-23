---
"@cognia/agent": minor
---

Publish `@cognia/agent` under Apache-2.0 and prove the boundary holds.

The client is transport-only, so it can be permissively licensed while the host and the runtime it
contains stay AGPL-3.0-only. That is a property of the artifact rather than a field in the manifest,
so `pack:test` now fails if a host binary, host source, or copyleft licence text ever appears inside
the client tarball, and if any optional host is pinned to anything but an exact version.

`pack:test` also stopped passing `--omit=optional`, which skipped the platform host packages and
therefore never exercised the one resolution path every real consumer takes. It now installs the
default way and, with a built platform host present, boots a real host through a bare
`createCogniaClient()` — checking versioned capabilities, opening a session and shutting down.
Pass `--require-host` to make a missing host fatal instead of a loud skip.
