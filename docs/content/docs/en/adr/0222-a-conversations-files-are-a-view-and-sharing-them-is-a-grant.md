---
title: "0222 — A conversation's files are a view, and sharing them is a grant"
description: "Each conversation gets a FileSpace: a derived virtual namespace over its execution roots, workspace roots, uploads and artifacts, addressable by deep link. Sharing files is either a snapshot (an ADR-0037 share link that now carries client-encrypted, chunked file blobs) or a live grant (a host-owned authorization enforced by a file gateway). Live grants serve external WebDAV/SFTP clients through a built-in provider or an optional SFTPGo provider, and serve collaboration members through a new host-request channel. An org file-sharing policy, the conversation role and the grant intersect; agents can share only inside their own conversation, with approval."
---

# ADR 0222 — A conversation's files are a view, and sharing them is a grant

**Status:** Proposed — P0 (FileSpace, links, Conversation files panel) and P1 (snapshot shares with files, file-sharing policy, collab `files.share`) shipped 2026-10-10
**Date:** 2026-10-10
**Design:** `docs/superpowers/specs/2026-10-10-conversation-filespace-and-sharing-design.md`
**Related:** [ADR-0037](./0037-public-share-links) (share links),
[ADR-0065](./0065-agent-workspace-confinement-and-permission-unification) (confinement),
[ADR-0111](./0111-managed-workspace-registry-and-bundle) (execution bindings),
[ADR-0124](./0124-filesystem-viewer-registry) (host-owned reads),
[ADR-0144](./0144-workspace-as-the-unit-of-work) (workspaces),
[ADR-0149](./0149-a-person-is-not-a-device) (identity and collaboration),
[ADR-0162](./0162-sftp-is-shell-equivalent) (SFTP, amended here),
[ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep) (Files)

## Context

A conversation's files are spread over its execution roots (managed worktrees,
shadows, or the project checkout), its workspace roots, its uploads and its
artifacts. Nothing presents them as one place, no link opens a conversation's
files, a shared conversation cannot carry files, and there is no way to give
someone (or a WebDAV/SFTP client) access to part of a conversation's working
directory without handing over a paired device or an SSH login.

The proposal that started this work asked for stored `ConversationFileSpace`
and `StorageMount` rows, a `snapshot | live` grant type, and SFTPGo virtual
folders per conversation. Three facts changed the shape:

- The question "which directories belong to this conversation" already has
  one authority: the execution binding (`SessionExecutionContext.execution.roots`,
  ADR-0111) falling back to `Project.roots`, resolved by
  `resolveSessionExecutionRoot`. A stored FileSpace would be a second answer.
- A snapshot share and live access cannot share one record. ADR-0037's server is
  blind and its non-goals exclude real-time shares; live access needs an online
  authority on the machine that holds the files.
- SFTPGo (AGPL-3.0) can only reach its own disk, collab-server has no channel
  to the host that runs a shared session, and ADR-0162 forbids listening sockets.

## Decision

### 1. FileSpace is derived, never stored

`lib/filespace/resolve.ts` projects a session into mounts: `/workspace` (the
primary execution lease, else the workspace's primary root), `/roots/<id>` for
each additional root, and read-only Dexie-backed `/uploads` and `/artifacts`.
Each disk mount carries its host path, its container path when a Docker
connection maps it, a `managed` flag and a status with a named reason
(`no-fs-backend`, `host-offline`, `managed-missing-on-device`,
`managed-deleted`). There is no `/shared`: a worktree-bound conversation does
not also expose the live checkout it was cut from.

Two reasons drafted earlier were dropped when P0 was built. A container runtime
mounts the host directory (a bind or a volume subpath the host also sees), so
rebuilding or discarding a container never takes a mount offline and there is
no `runtime-ephemeral` state. A conversation on an ADR-0221 remote sandbox runs
on a remote clone; it will be marked `remote-sandbox`, and refused by live
grants, once that ADR exposes a per-session placement to read. Until then
nothing can produce the reason, so no type carries it.

### 2. Links address a conversation's files

`cognia://session/<id>?view=files&path=<FileSpacePath>&line=<n>` on desktop and
`/?session=<id>&view=files&path=…` in the app; the CLI's `open` mirrors it.
Unknown `view` values degrade to opening the conversation. Mobile opens the
conversation and ignores file fields. A new dock panel, Conversation files,
lists the mounts and opens disk mounts in the existing workspace editor.

### 3. A snapshot is a share link that carries files

ADR-0037 is extended, not replaced. The encrypted payload gains a file
manifest; file bytes are uploaded as chunked blobs under the same share code.
Each file's key is derived from the fragment key with HKDF (salt = blob id), and
each chunk's AAD binds code, blob id, index and count, so the server still sees
only ciphertext. A read ticket returned with the envelope keeps a
burn-after-read share's files downloadable for one ticket lifetime. Revoking or
expiring the share deletes its blobs. Both server implementations (Rust and
Worker) implement the same `/v1` endpoints and constants. Chat shares also stop
emitting unresolved `cognia-media:` image references.

As built in P1: each blob's chunk IVs share a random 8-byte prefix carried in
the manifest, and a passphrase share uses its PBKDF2 output as the HKDF input,
so its files need the passphrase too. Because the manifest's checksums travel
inside the envelope, the client hashes every file before creating the share and
re-hashes while uploading; a file that changed in between is refused and the
half-made link withdrawn. Workspace files are read through a new ranged host
command (`fs.workspace_file.read_chunk`), so memory stays one chunk per upload.

### 4. Live access is a host-owned grant enforced by a gateway

`crates/cognia-file-share` (platform layer) owns `file-share.sqlite`: the mount
table pushed by the WebView or headless brain, grants with paths, permissions
(`read`, `download`, `write`), audience (`credential` or `collab`), status and a
mandatory expiry, credentials (Argon2id), persisted auth backoff and a durable
audit log. Every live operation goes through one gateway that checks, in order:
the grant, the mount (session active, mount available, fingerprint unchanged —
otherwise the grant becomes `stale`), the effective policy at its current
revision, path confinement through `cognia-files`, and a sensitive-file floor
that no grant overrides.

### 5. Providers speak protocols; they do not decide access

The built-in provider runs WebDAV (`dav-server`, Apache-2.0) and SFTP (`russh`
plus `russh-sftp`, subsystem only — no shell, exec or forwarding) on their own
listeners, off by default, bound to loopback unless the user chooses LAN or a
tunnel. Both route every operation through the gateway. The SFTPGo provider
provisions one SFTPGo user per credential with virtual folders translated
through a configured path mapping, expiry and denied patterns. A grant whose
paths SFTPGo cannot see fails closed. SFTPGo is deployed as a separate service
(`deploy/compose`) and never bundled.

### 6. Collaboration members reach the host through requests

Collab-server gains a registered file host per shared session (a hashed host
token), a mirror of grants with a `collab` audience, and a request table. A
member's request is stored, announced on the existing session stream, claimed
by the host, re-authorized by the host's gateway, and answered with bounded
JSON or a requester-only, expiring attachment. The headless brain's
reader-only rule is amended for this responder alone.

### 7. Permission is an intersection, and policy can only narrow it

Effective access = conversation role (server-authoritative for shared
sessions, with new `files.share`, `files.readLive` and `files.writeLive`
actions) ∩ mount capability ∩ grant ∩ effective policy (local settings ∩
`org_file_sharing_policies`) − sensitive floor. A creator cannot grant what they
do not hold. Tightening a policy suspends grants above the new ceiling.

### 8. ADR-0162 amended: one confined listener is allowed

ADR-0162 keeps its rule for SSH: no listening socket for shell, exec or
forwarding. The file-share listener is a deliberate exception because it is
not shell-equivalent: it authenticates a per-grant credential, serves only the
grant's paths through the gateway, never trusts loopback (tunnelled requests
arrive from 127.0.0.1), and is off until the user enables it.

### 9. Agents share inside their own conversation, with approval

The `filespace_*` built-in tool family follows the artifact-tool pattern.
`filespace_list`, `filespace_revoke_share` and `filespace_disable_webdav` are
allowed. `filespace_share` and `filespace_enable_webdav` ask, cannot be
persisted as "allow always", are injected only when the policy allows agent
sharing, and classify as `external-send`. Tools are bound to the calling
session. A tool result never contains a password.

### 10. Lifecycle cascades are explicit

`SESSION_DELETED` has no subscribers, so the session deletion teardown and the
routed archive writer call the cascade directly. Deleting a conversation
revokes its live grants and deprovisions their credentials. Snapshot shares
survive as independent encrypted copies, and the delete dialog offers to
revoke them. Archiving suspends live grants. Forks copy nothing. A rebind or
move makes grants stale. A share's revocation or expiry removes its blobs.

## Consequences

- One resolver answers "what are this conversation's files" for the panel,
  links, snapshots, live grants and agent tools.
- Snapshot sharing keeps the zero-knowledge property while carrying up to the
  configured per-file and per-share limits instead of 10 MiB in total.
- The host gains a new inbound surface. It is off by default, credential-scoped,
  rate-limited, audited and revocable per operation.
- Collab-server gains three tables and a request route. Hosts that never
  register keep today's behaviour.
- Delivery is phased (P0 FileSpace and links, P1 snapshots and policy, P2 live
  grants and providers, P3 collaboration members, agent tools and lifecycle).
  This ADR moves to Accepted when P3 ships and the spikes listed in the design
  (WebDAV clients, SFTP clients, SFTPGo round trip) pass.

## Rejected

- **Stored FileSpace rows.** A second authority for a conversation's directories.
- **Live access through share links.** Breaks the blind server and ADR-0037's non-goals.
- **SFTPGo only.** Cannot see desktop files, and its license makes bundling impossible.
- **WebDAV inside the companion router.** That router has a 64 KiB body cap,
  treats PROPFIND as a mutation while draining, and trusts loopback.
- **Reusing `ssh.files` or Control grants.** They mean the whole machine, not
  these paths of this conversation.
