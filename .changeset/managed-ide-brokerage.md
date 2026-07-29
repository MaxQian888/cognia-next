---
"cognia-next": minor
---

The Pro IDE is no longer a VS Code window that happens to sit next to Cognia — the two now share a runtime. A pinned bridge extension inside code-server exposes Cognia's services to anything running in the editor: an agent can read and write through managed content handles rather than guessing at paths, provider calls made from the editor route through the same credentials and model routing the rest of the app uses, and a generated proxy extension lets an existing VS Code extension reach those services without being rewritten.

The broker answers from every surface that already talks to the desktop app, not just the embedded pane — the Tauri window, a paired companion device, a headless deployment, and the sidecar all resolve the same services, so work started from your phone behaves the way it does in the pane. Managed extension storage keeps per-workspace state on the Cognia side instead of inside a code-server install that gets replaced on version bumps.

The managed and native profiles are separate trust domains with separate extension directories: broker credentials are issued to managed only, and switching profiles retires the other one first so two extension hosts never share a workspace. A kill switch (`COGNIA_MANAGED_IDE_KILL_SWITCH`) disables the whole platform without a downgrade.

Still macOS and Linux only, still downloaded on first use and SHA-256-verified against a pinned version, still served loopback-only. Monaco remains the default editor; the web and mobile shells have no code-server at all and are unaffected.
