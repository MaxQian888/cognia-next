---
"cognia-next": minor
---

Let a paired device run agents on another machine — and make elevated permissions grantable on a server at all.

Driving a remote Cognia host could open a terminal, read and write files and use git, but never start an agent there. Those commands accepted only the token the server's own brain uses internally, and pairing gives a device a different kind of credential — so there was no combination of settings that could reach them. There is now a per-device "Run agents" permission, separate from "Remote control": remote control steers work the machine already decided to run, while this starts new processes, and folding them into one switch would mean enabling the first quietly handed out the second. Both ask for biometric confirmation when you turn them on.

What a granted device may start does not widen: the host still only runs a fixed list of agent programs, only inside a workspace folder, and only with an allowlisted environment. Every start and every refusal is written to the host's audit log with the device that asked.

Underneath that, a bug that made the existing permissions unreachable on a server. Elevated permissions are stored per device and loaded into the running server at startup — but the only thing that ever loaded them was the desktop app's own window. A `cognia-server` has no window, so its permission list was always empty and every elevated command was refused no matter what the operator intended. File writes, commits and pushes against a cloud host could not be granted from anywhere. `cognia-server devices grant`, `revoke` and `grants` are the missing half; grants are stored beside the server's other credentials and take effect at its next start, which the command tells you.
