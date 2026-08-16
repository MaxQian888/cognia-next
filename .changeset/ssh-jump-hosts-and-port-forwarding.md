---
"cognia-next": minor
---

Reach servers through a bastion, and carry ports over an SSH terminal session.

A saved SSH host can now name another saved host to connect through. The chain is walked outermost first and every hop is a server in its own right: it authenticates on its own account, against its own keyring entry, and its host key is trusted separately — so a changed key on any hop fails the whole connection closed and says which hop it was. Cycles and chains longer than five hops are refused before a socket is opened.

Port forwarding is configured per host and runs inside the same connection. A local forward (`-L`) listens here and hands each connection to the server; a remote forward (`-R`) has the server listen and send connections back to this machine. Both ends always bind `127.0.0.1` — that is a constant, not a setting, so a tunnel can never be reached from the LAN. Remote forwards start switched off and say plainly what turning one on means, because it opens a listening socket on someone else's machine pointing at yours.

Forwarding never travels with a profile synchronized to the terminal host, so a phone or LAN client that names a profile id still gets a shell and can never make the desktop open a port.

An SSH tab gains a forwarding rail showing what each rule is actually doing — listening, waiting for the connection to come back, or failed with the reason — along with live and queued connection counts, and a switch to start or stop a rule without reconnecting. A local forward keeps its socket bound through a reconnect and parks callers until the link returns, so a dropped connection is invisible to whatever is using the tunnel.

This replaces the previous jump-host and forwarding module, which produced OpenSSH command-line flags that nothing consumed: no `ssh` binary is ever executed, and every hop and tunnel is opened in-process.
