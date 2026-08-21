---
"cognia-next": minor
---

Make a desktop host able to dispatch to the execution workers it already accepts, and give a worker machine a real daemon.

Cross-host worker dispatch (ADR-0113) was complete on both ends but connected to nothing on desktop: the only caller of the remote-worker runtime lived in the headless `cognia serve` process, so a desktop host authenticated an enrolled worker, listed it online in Fleet, and silently discarded every frame it tried to send. The WebView is now the brain for that host, over a Tauri IPC channel with an explicit inbound byte budget the renderer releases by acking. When a host cannot dispatch, the Fleet card says so instead of showing a healthy-looking worker that will never receive a run.

Reaching that required the Agent SDK to stop being Node-only — it bound to `node:readline`, `node:crypto`, and `node:stream`, which is why a second implementation of sessions, event replay, and steering would otherwise have been needed for the WebView. The RPC peer now takes a structural transport (a real `node:stream` still satisfies it unchanged) and the client only reaches the host-spawning module when it is actually spawning a host, so one worker pool serves both brains.

`cognia-agent worker` gains `daemon start|stop|status|logs|gc` and `service install|uninstall`. A worker started from a terminal used to die with that terminal — the machine left the fleet while still showing as enrolled, so runs were placed on it and waited. The daemon detaches, survives a reboot via a per-user LaunchAgent, systemd user unit (with an XDG autostart fallback), or logon task, rotates and reclaims its own logs and abandoned task workspaces, and restarts itself onto a newer CLI at the first moment no turn is in flight.

Hosts also stay awake while they owe work — an in-flight run or an attached worker holds a reference-counted power assertion — and a host can send a Wake-on-LAN magic packet to a worker that is asleep rather than gone, using the MAC that worker advertised in its manifest.
