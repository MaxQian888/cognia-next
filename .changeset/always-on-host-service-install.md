---
"cognia-next": minor
---

Run an always-on host on your own machine: `cognia-server service install` sets it up as a boot-time LaunchDaemon or systemd unit running as your account, `cognia-server init` creates the master key (in the data dir, or the macOS Keychain with `--keychain`), the host also reads its key from a systemd credential, and a signed macOS host archive bundles the server, brain and Node.
