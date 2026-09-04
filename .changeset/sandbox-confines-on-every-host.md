---
"cognia-next": minor
---

The built-in execution sandbox now works on macOS and reaches the CLI and the headless host.

On macOS the one-shot backend was dead: its Seatbelt profile scoped file reads to a list of system prefixes, which aborts every confined binary on current macOS before it execs. `sandbox_bash` returned exit -1 with no output, "Verify confinement" reported unconfined, and the settings badge still said Active. The profile now allows reads and re-denies every credential store as the last matching rules, anchored at your home directory and the app's own store rather than at whatever the caller declared readable, so `~/.ssh` stays unreadable even when the workspace sits elsewhere. The one-shot and interactive profiles share one renderer now, which is what let them drift apart.

The forbidden-writable floor missed the macOS system roots: `/etc` is a symlink to `private/etc`, so a request naming `/etc` or `/var/run` as a writable root was accepted while `/usr` and `/bin` were correctly refused.

Sandbox mode was desktop-only by accident. The OS tier routed through a Tauri command, so on `cognia-agent` a session bound a resource ceiling, clamped every model request against it, and reported the sandbox as enabled while nothing enforced any of it. The CLI now runs the identical confinement through a `cognia-sandbox-exec` helper, and `sandbox/status` reports what an active confinement probe observed instead of whether a settings field was filled in. Turn it on with a `sandbox` block in the CLI config (`enabled`, `tier`, and a `policy` ceiling the model can narrow but never widen). A host with no sandbox backend refuses sandboxed tool calls with the reason and the remedy rather than running them unconfined.
