---
title: "0162: SFTP is shell-equivalent, and says so"
description: "File transfer over a saved SSH profile grants exactly what a shell on that machine already grants, so it is authorized as its own ssh.files grant rather than borrowed workspace vocabulary, approved once per transfer rather than once per chunk, and never confined to a root it cannot enforce."
---

# ADR 0162: SFTP is shell-equivalent

**Status:** Accepted  
**Date:** 2026-09-01  
**Builds on:** [ADR-0082](./0082-remote-development-remote-host), [ADR-0031](./0031-integrated-terminal)

## Context

The repository has a complete SSH client. `crates/cognia-terminal/src/ssh.rs`
carries password, private-key and agent authentication, TOFU `known_hosts` with
a fail-closed response to a changed key, jump chains to depth five, `-L` and
`-R` forwarding, and OSC 633 injection over the remote shell. It has no SFTP and
no SCP. There is no client, no protocol frame, no interface and, until now, no
record of why file transfer was absent rather than refused.

A paired phone or browser can already open a shell on a saved SSH host. The
`/ws/terminal` Spawn frame carries a profile identifier and nothing else, and
`TerminalHost::spawn_synchronized_profile` resolves it against the
`ssh_profiles` map its own desktop synchronized, dialling with credentials that
never leave the host process. That is ADR-0082 decision 8, and it is live.

The obvious way to add file transfer is to copy the vocabulary of the workspace
file API. `fs_list_workspace_dir` and its nine siblings are `execution` scoped,
reachable over http, websocket and webrtc, and authorized as `host.observe` for
reads and `workspace.write` for writes. Copying that would be wrong, and the
reason is the whole subject of this record.

Those calls are safe under those names because `authorize_workspace_root`
confines every one of them to a directory the host has registered. The client
supplies a `root` and a `relPath`, and a `relPath` that escapes its root is
rejected on disk. **SFTP has no equivalent.** An SFTP path is a remote absolute
path. Refusing `..` does not stop `/etc/shadow`, and it does not stop a symlink
placed by the remote machine's own administrator. There is no root to authorize
against, because the thing being reached is somebody else's filesystem.

ADR-0082 decision 9 refused to let a paired device start a port forward. It is
worth being precise about why that refusal does not extend here, rather than
either quietly widening it or quietly obeying it.

## Decision

### SFTP grants what a shell grants, and the interface does not pretend otherwise

A shell on a machine already reads and writes its entire filesystem. `cat`,
`>`, `tar` and `scp` are all reachable from the prompt a paired device can
already open. SFTP over the same saved profile adds an interface, not authority.

So this ADR does not claim a confinement it cannot enforce. The documentation,
the grant description and the device console all state that a device holding
this grant can read and write the target machine as the profile's user.

### Reachable only through a profile the desktop already synchronized

The same rule the shell has. A paired device names a profile identifier and
nothing more. It may not create or modify an SSH profile:
`TerminalHost::sync_ssh_profile` and `replace_synchronized_profiles` stay
local-identity only, and a device hello carrying `sshProfiles` is still refused.
Nothing here widens decision 8.

### A dedicated `ssh.files` grant, not the workspace vocabulary

Reusing `host.observe` and `workspace.write` would report a scope these calls do
not have. A reader auditing a device's grants would see the same two names for
"read a registered workspace directory" and "read any file on a production
server", which are not the same permission.

`ssh.files` is therefore its own grant, off by default, listed on the device
console beside the existing ones, with the shell-equivalence stated in its
description. A device granted `terminal.open` does not receive it implicitly,
even though a device with `terminal.open` could reach the same bytes the long
way. Making the user grant it separately is what keeps the audit trail honest.

### No listening socket, ever, which is why decision 9 is untouched

Decision 9 refused forwarding because a forward makes the host, or a machine the
host can reach, **bind a socket**. That is a new inbound surface, and it is the
thing that was refused. SFTP binds nothing. It opens a subsystem channel on the
same outbound connection the shell uses.

The synchronized profile keeps losing its jump chain and its forwarding rules
exactly as before. A paired device naming a profile gets a shell and a file
transfer, and still never a listening port.

### Approval once, at open, never per chunk

The transfer commands are chunked because the RPC body ceiling is 64 KB. A chunk
command carrying `approval: "interactive"` would prompt the user once per chunk,
which for a 100 MB file is over three thousand prompts. That is not a security
control. It is a denial of service against the person being protected.

`sftp_upload_open` and `sftp_download_open` carry the approval. Each mints a
short-lived transfer token bound to the initiating device, the profile, the
path, the declared size and the direction. `sftp_upload_write_chunk`,
`sftp_download_read_chunk` and `sftp_upload_commit` verify that token and carry
no approval of their own. This is the shape `session_attachment_upload_*`
already uses, and the reason it can be `approval: "none"`.

### A transfer handle belongs to exactly one device

The token binds the device that opened it. One phone cannot write bytes into
another phone's upload, and a handle that leaks is useless to anyone else. The
host owns the write head, so a client cannot name an offset the host did not
reach.

### SFTP sessions are visible where terminal sessions are visible

A pooled connection with an idle timeout that nobody can see would be the one
genuine asymmetry with a shell. A shell appears in the host's session list and
its audit events. So does an SFTP session. "A phone is reading files on the
production box" has to be observable, or the grant above is unauditable.

### The pool is keyed on a configuration fingerprint, not on a profile identifier

`sync_ssh_profile` replaces a profile by identifier. A pool keyed on the
identifier alone would keep a live connection to the machine the profile used to
name, authenticated with the credential it used to carry, and hand it to the
next caller who asked for the new one. The key is the identifier plus a
fingerprint over the resolved destination, credential reference and jump chain.

### A separate SSH session, not a channel on the terminal's

Termius and VS Code Remote both open their own. Binding transfers to a terminal
tab means closing an unrelated tab kills a running transfer, and it makes file
browsing impossible without first opening a shell nobody wanted. The cost is a
second authentication, which is paid by the host process out of the same
keyring, and a second traversal of the jump chain.

The host-key verdict is reused rather than re-derived, so the same machine is
never presented for trust twice in one session.

## Consequences

- A paired device with `ssh.files` can read and write the target machine as the
  profile's user. This is stated, not implied, in three places: this record, the
  grant description, and the console row.
- A paired device without `ssh.files` cannot transfer files, even if it holds
  `terminal.open` and could reach the same bytes through the shell. The two
  grants are deliberately not folded together.
- Nothing a paired device does can cause a socket to be bound. Decision 9 stands
  unmodified.
- An interrupted transfer resumes from the host's write head rather than the
  client's arithmetic, and a token that has expired forces a fresh approval.
- A profile edited while a transfer is running invalidates the pooled connection
  on the next open, because the fingerprint changed. The running transfer is not
  retargeted mid-flight.
- There is no SCP. SFTP covers the same ground with a protocol that reports
  errors, and adding a second transfer vocabulary would double the surface this
  record has to describe.

## Alternatives considered

**Confine SFTP to a declared remote root.** Rejected, because the confinement
cannot be enforced. The remote machine resolves its own symlinks and the client
can name absolute paths. A limit stated in the interface and absent on the wire
is worse than no limit, because it tells the reader something untrue about what
a grant permits.

**Reuse `host.observe` and `workspace.write`.** Rejected. The names would report
a scope the calls do not have, and the device console would show the same
permission for two very different reaches.

**Put bulk transfer on terminal frames 26 and 27.** Rejected. It is cheaper in
registration and it costs the entire authorization chain: the frames plane
authenticates once as `terminal.open`, so SFTP would inherit that grant and the
capability check, the approval and the audit ledger would all have to be
reimplemented inside the frame handler. `remote_execution.rs` already does all
four for an RPC. Throughput is addressed with concurrent in-flight chunks and a
host-negotiated chunk size instead.

**Bind SFTP to an already-open terminal session.** Rejected for the reason
above: a transfer that dies when an unrelated tab closes is a worse failure than
a second authentication.
