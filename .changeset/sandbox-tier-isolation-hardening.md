---
"cognia-next": patch
---

Harden every shared sandbox tier: container specs now carry PID limits, `cap-drop ALL` with minimal re-grants, `no-new-privileges`, and read-only rootfs where compatible; ambient provider credentials are stripped from sandbox spawn environments (managed gateway-task leases still pass, reported as `credentials.mode: "gateway-lease"`/`"none"`); macOS denies keychain paths and the Docker socket; Linux validates readable roots and applies an NPROC cap; and each tier gains a Docker-socket-unreachable test.
