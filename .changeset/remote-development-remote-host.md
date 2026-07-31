---
"cognia-next": minor
---

Add "Remote hosts" (Settings → System → Remote hosts) — pair this desktop with a remote Cognia server and drive its terminal, files, and git from here, as if they were local (ADR-0082). Pair a host by pasting the `cgnp2` payload that `cognia-server pair` prints (or a raw pair JWT + URL), then Connect to start driving it: new terminals open on the remote host over its `/ws/v1/terminal` socket, and file/git operations route to it. Disconnect returns everything to the local machine.

Under the hood the desktop transport is now a routing layer: with no remote host connected it is byte-for-byte the previous local behavior, so nothing changes until you explicitly connect. The active host is per-session — every launch starts local, so the app never silently drives a remote machine on boot.

Reads (open files, `git status`, diff, log) work as soon as a host is paired; writing files, commits, and pushes additionally require the host to grant this device control in its allow-list, and the UI says so. Remote external agents, remote LSP/code-server, and SSH provisioning are follow-on phases and are not included here.
