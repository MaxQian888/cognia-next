---
title: "0222 — A conversation's files are a view, and sharing them is a grant"
description: "Each conversation gets a FileSpace: a derived virtual namespace over its execution roots, workspace roots, uploads and artifacts, addressable by deep link. Sharing files is either a snapshot (an ADR-0037 share link that now carries client-encrypted, chunked file blobs) or a live grant (a host-owned authorization enforced by a file gateway). Live grants serve external WebDAV/SFTP clients through a built-in provider or an optional SFTPGo provider, and serve collaboration members through a new host-request channel. An org file-sharing policy, the conversation role and the grant intersect; agents can share only inside their own conversation, with approval."
---

# ADR 0222 — A conversation's files are a view, and sharing them is a grant

**Status:** Accepted — P0 (FileSpace, links, Conversation files panel), P1 (snapshot shares with files, file-sharing policy, collab `files.share`), P2 (live grants over WebDAV/SFTP, the SFTPGo provider, network-drive settings) and P3 (collaboration members, agent tools, lifecycle) shipped 2026-10-10. Spikes run on macOS: curl and Finder against the built-in WebDAV listener, OpenSSH `sftp` against the built-in SFTP listener, and the SFTPGo round trip (create, suspend, resume, rotate, revoke). Windows WebClient, rclone, Cyberduck, WinSCP and the cloudflared tunnel have not been run against a real client yet.
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

As built in P2:

- **One command surface.** Thirteen commands live in
  `crates/cognia-file-share/src/rpc.rs`, called both by the desktop's
  `#[tauri::command]` shells and by the companion RPC, so a paired device and
  the WebView send the same arguments. `file_share_activate`,
  `file_space_sync` and `file_share_policy_set` are host-only (service
  scope); the reads need `host.observe` and page by token; grant changes are
  `workspace.write` control commands; the listener and SFTPGo settings are
  `host-admin` with step-up. The audit records `owner` for the app and the
  brain and `device:<id>` for a paired device.
- **The host pulls mount tables.** The WebView or brain pushes tables for
  conversations with grants, and the host also asks for one whenever it
  needs it fresh: on every grant creation (which is how a grant made from a
  paired device binds to current paths), on resume, and once a minute for
  every conversation with an open grant (`companion://filespace-mounts-request`
  over the desktop bridge; the brain announces a `filespace` capability). A
  failed pull keeps the last table, and an answer for another conversation is
  refused. Dexie-backed files are read the same way, in slices of at most
  4 MiB.
- **Which directories may be shared.** A disk mount must lie under a root the
  host would share: on the desktop an active project root or the managed
  execution directory under the app's data directory (never the app data,
  `~/.claude` or a dialog-granted path), on a headless server the spawn
  policy's workspace root.
- **The host owns the account.** The desktop's account session binds the
  unlocked account on unlock and unbinds it on lock; the renderer can only
  confirm that account, never name another, and re-confirming it keeps live
  connections. A headless server binds its local account at boot.
- **Fewer modules than drafted.** Maintenance (expiry, policy re-check, the
  provider retry queue, mount pulls) runs in `service.rs`; there is no
  `provider.rs` trait, because the two providers differ in what they keep
  (a hashed password versus a provisioned SFTPGo user) more than they share.

### 5. Providers speak protocols; they do not decide access

The built-in provider runs WebDAV (`dav-server`, Apache-2.0) and SFTP (`russh`
plus `russh-sftp`, subsystem only — no shell, exec or forwarding) on their own
listeners, off by default, bound to loopback unless the user chooses LAN or a
tunnel. Both route every operation through the gateway. The SFTPGo provider
provisions one SFTPGo user per credential with virtual folders translated
through a configured path mapping, expiry and denied patterns. A grant whose
paths SFTPGo cannot see fails closed. SFTPGo is deployed as a separate service
(`deploy/compose`) and never bundled.

As built in P2: the listener's exposure is `loopback`, `lan` (WebDAV over
HTTPS with the companion certificate, SFTP with a persistent Ed25519 host key)
or `tunnel` (a cloudflared child, quick or named, fronting WebDAV). Each
credential's card shows the reachable addresses, both fingerprints and the
steps for Finder, Windows, rclone and OpenSSH; an unreachable share says why
(`listener_off`, `sftpgo_unconfigured`, `sftpgo_no_public_endpoint`). The
listeners and the tunnel child appear in the process registry as the
`fileShare` subsystem. SFTPGo changes that fail are queued and retried while
the grant stays revoked locally. The surfaces are the Files panel's "Shared as
network drive" section and Settings → Connectivity → Network drive; the
overlay is `deploy/compose/compose.sftpgo.yaml`.

### 6. Collaboration members reach the host through requests

Collab-server gains a registered file host per shared session (a hashed host
token), a mirror of grants with a `collab` audience, and a request table. A
member's request is stored, announced on the existing session stream, claimed
by the host, re-authorized by the host's gateway, and answered with bounded
JSON or a requester-only, expiring attachment. The headless brain's
reader-only rule is amended for this responder alone.

As built in P3:

- **The responder is the host crate, not the brain.** `crates/cognia-file-share/src/collab.rs`
  runs one long-poll loop per registered conversation on whichever host
  holds the files, the desktop and a headless server alike, and answers
  through the same gateway as WebDAV and SFTP (principal `member:<usr_id>`,
  channel `collab`, a viewer never mutates). The brain does not answer, so its
  reader-only rule stands unamended.
- **No stream event.** A request is not announced on the session stream. The
  host long-polls `POST …/file-host/claim` (up to 25 s, woken in-process
  when a request arrives) and the member polls the request with backoff. A
  request nobody claims within two minutes expires and the member sees the
  host as offline; a conversation holds at most 32 open requests, 8 per member.
- **Registration from the person, token to the host.** The registration is
  made with the sharing person's own sign-in (`files.share`), from whichever
  device they share on; the host receives only the token, through
  `file_collab_host_set` (`host-admin`, step-up, so a paired device needs an
  admin lease), and keeps it in `secret_store` under
  `collab-host:<account>:<session>`. `file_collab_host_status` reports it.
  The server re-checks the registrant's `files.share` on every host call.
  Re-registering replaces the host and revokes the old registration's grants
  on both sides (`collab_host_removed`); a grant binds to the registration it
  was made under.
- **Mirror as an outbox.** Every grant change bumps a revision; the host
  pushes the latest state until the server accepts it, so a retry never
  carries a stale one. A refusal under the org's policy suspends the grant on
  the host (`org_policy`).
- **Bytes.** Uploads and answers travel through the attachment object store
  under request-scoped keys, not `chat_attachments`, so the attachment table
  gained no columns. Transfers are capped at 50 MiB, JSON answers at 256 KiB,
  listings at 1,000 entries.
- **Surfaces.** Members use a Files section in the shared-conversation panel
  (`components/chat/shared-session-files.tsx`); the owner sees which host
  serves them and can stop it from the Files panel
  (`components/filespace/collab-host-status.tsx`). Every live share, from the
  dialog or an agent, is created through one door
  (`lib/filespace/live-share.ts`): the collaboration plane's `files.share`
  check, the host registration for a members share, then the grant.

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

As built in P3: a grant an agent creates is `createdBy: agent`, and the host
re-checks `allow_agent_sharing` for it at creation and while it lives. The
result card in the chat issues the password on the person's device
(`file_credential_rotate`), never through the model. `filespace_share` takes
`audience: "members"` with a lowest role; choosing individual members is left
to the dialog.

### 10. Lifecycle cascades are explicit

`SESSION_DELETED` has no subscribers, so the session deletion teardown and the
routed archive writer call the cascade directly. Deleting a conversation
revokes its live grants and deprovisions their credentials. Snapshot shares
survive as independent encrypted copies, and the delete dialog offers to
revoke them. Archiving suspends live grants. Forks copy nothing. A rebind or
move makes grants stale. A share's revocation or expiry removes its blobs.

As built in P3: the host already suspends, resumes and revokes from the
conversation state each mount table carries, so the writers
(`deleteSessionsWithTeardown`, `setSessionsArchived`, and the Host applying a
paired client's change) announce the change through `lib/filespace/lifecycle.ts`
and the running host sync pushes the tables at once instead of on its next
minute. Deleting a conversation also unregisters its file host from the
collaboration server.

## Consequences

- One resolver answers "what are this conversation's files" for the panel,
  links, snapshots, live grants and agent tools.
- Snapshot sharing keeps the zero-knowledge property while carrying up to the
  configured per-file and per-share limits instead of 10 MiB in total.
- The host gains a new inbound surface. It is off by default, credential-scoped,
  rate-limited, audited and revocable per operation.
- Collab-server gains three tables and a request route. Hosts that never
  register keep today's behaviour.
- Delivery was phased (P0 FileSpace and links, P1 snapshots and policy, P2 live
  grants and providers, P3 collaboration members, agent tools and lifecycle).
  The client spikes that remain (Windows WebClient, rclone, Cyberduck, WinSCP,
  the tunnel) gate only which combinations the UI recommends, not the design.

## Rejected

- **Stored FileSpace rows.** A second authority for a conversation's directories.
- **Live access through share links.** Breaks the blind server and ADR-0037's non-goals.
- **SFTPGo only.** Cannot see desktop files, and its license makes bundling impossible.
- **WebDAV inside the companion router.** That router has a 64 KiB body cap,
  treats PROPFIND as a mutation while draining, and trusts loopback.
- **Reusing `ssh.files` or Control grants.** They mean the whole machine, not
  these paths of this conversation.
