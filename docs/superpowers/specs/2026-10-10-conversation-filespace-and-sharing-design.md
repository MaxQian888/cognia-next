# Conversation FileSpace and file sharing — design

**Date:** 2026-10-10
**Status:** Draft for review (pairs with ADR-0222)
**Scope:** P0 → P3 of the "conversation-scoped FileSpace & sharing" proposal, re-cut against the code on `dev`.

Decisions taken with the user before this draft:

| Question | Decision |
| --- | --- |
| Who serves WebDAV/SFTP | Built-in Rust provider by default; SFTPGo as an optional, pluggable provider for server deployments. Both share one grant/credential/revocation model. |
| Snapshot size | Extend the share server with client-encrypted, chunked file blobs under the same share code. The key stays in `#k=`. |
| Who gets live access | Both protocol credentials (external WebDAV/SFTP clients) and collaboration members (in-app browsing). Effective permission = conversation role ∩ grant ∩ new org policy, enforced on the host. |
| Delivery | ADR + design first; then P0 → P1 → P2 → P3, each phase complete (tests, i18n, changeset, gates) before the next. |

---

## 1. Review of the proposal against the code

The proposal is directionally right: the conversation owns the files, sharing is a grant, and SFTPGo is a provider rather than the core. Six of its assumptions do not hold on `dev`, and the design changes accordingly.

| Proposal says | The code says | This design |
| --- | --- | --- |
| Add `ConversationFileSpace` and `StorageMount` tables. | A conversation's directories already have one authority: `SessionExecutionContext.execution.roots[]` (Registry Bundle leases, ADR-0111) with a fallback to `Project.roots`. `resolveSessionExecutionRoot` (`lib/workspace/session-root.ts`) is the one rule. Uploads (`session-assets.ts`) and artifacts (`artifacts` table) are already per-session. | **FileSpace is derived, never stored.** A pure resolver projects existing bindings into a virtual namespace. A second table would be a second answer to "which directory", which ADR-0144/0111 removed on purpose. |
| `/workspace → Docker Volume`. | No per-session volume exists. Desktop Docker mounts are per connection (`DockerSandboxConfig.workspaceMount`); the server runner mounts a deployment volume at `/workspace`; devcontainer `mounts` are refused (`devcontainer.ts:104-117`). | Each FileSpace mount carries the host path **and**, when a sandbox maps it, the container path (`containerPathFor`). No new volume concept. |
| `/artifacts → persistent storage`, `/shared → project storage`. | Artifacts and uploads live in Dexie (bytes in `messageMedia`). ADR-0200 already keeps them past session deletion when kept in Files. Project roots *are* the workspace; a worktree-bound conversation works in a copy of them. | `/artifacts` and `/uploads` are Dexie-backed, read-only mounts. There is no `/shared`: the project checkout is exposed as `/workspace` when the conversation runs on it, and is deliberately not exposed when the conversation runs in a worktree (exposing the live checkout beside its worktree copy is how people edit the wrong tree). |
| `ConversationFileGrant.mode: "snapshot" \| "live"`. | Snapshot shares already have a record (`sharedLinks`, ADR-0037) and a blind server. Live access needs a host-side authority. | Two concrete records, one UI. A **snapshot** is a share link whose encrypted payload carries files (the `sharedLinks` row gains a file manifest). A **live grant** is a new host-owned row. Merging them would put a zero-knowledge object and an online ACL behind one type that cannot honour both. |
| SFTPGo virtual folders map conversations. | SFTPGo is AGPL-3.0 and can only reach its own machine's disk; desktop files are unreachable from it. `russh`/`russh-sftp` are already in `Cargo.lock`; `dav-server` 0.11 is Apache-2.0 and on http 1 / hyper 1 like axum 0.8. | Provider trait. Built-in WebDAV + SFTP in a new crate; SFTPGo provider for headless deployments where SFTPGo shares the volume. A grant whose mount SFTPGo cannot see fails closed with a named reason. |
| "Reuse the Collaboration policy engine" and "Organization Policy". | Collab has session roles and `authorize_session_action`, but **no file actions, no org policy table, and no channel from collab-server to the host**: the session stream is server→client notification only, `append_event` is allow-listed, the lease holder's device id is an unauthenticated label, and the headless brain is read-only. | New collab actions, an `org_file_sharing_policies` table, and a host-request channel (requests stored on collab-server, notified on the stream, pulled and answered by a registered host). |

Security gaps found in passing that this work must not inherit:

- The Rust sensitive-file floor (`is_sensitive_workspace_file`) is applied only by `fs_walk_workspace`; read/list/stat/search return `.env` and key files. Local root confinement is shadow-only.
- File access audit is an in-memory ring buffer with no production consumer.
- ADR-0162 says "No listening socket, ever". A WebDAV/SFTP listener is a new inbound surface and needs an explicit superseding decision (ADR-0222 §8).
- The cloudflared tunnel forwards the whole companion router and tunnelled requests arrive from 127.0.0.1, so `require_loopback_operator` treats them as local. The new listener must never trust loopback (tracked separately; see §13).
- Chat share/export renders `cognia-media:<sha256>` image references verbatim, so a shared conversation's images do not resolve for the recipient. P1 fixes it, because it extends the same payload.

---

## 2. Glossary

- **FileSpace** — the virtual namespace of one conversation. Derived on demand from the session, its workspace, its execution binding, its uploads and its artifacts. Never persisted as its own row.
- **Mount** — one entry of a FileSpace: a stable virtual prefix (`/workspace`, `/roots/<logicalRootId>`, `/uploads`, `/artifacts`) bound to a backing store (`disk` or `dexie`).
- **Mount fingerprint** — SHA-256 of `(sessionId, mountId, canonical host root)`. A live grant records it at creation; a mismatch later means the mount now points somewhere else.
- **Snapshot share** — an ADR-0037 share link whose encrypted payload includes a file manifest, with file bytes stored as encrypted chunked blobs under the same share code.
- **Live grant** — a host-owned authorization for continuous access to paths in one FileSpace, for an audience, with permissions and an expiry.
- **Audience** — who a live grant is for: `credential` (anyone holding a WebDAV/SFTP credential issued for it) or `collab` (members of the bound shared session, optionally narrowed to listed users and a minimum role).
- **Provider** — the component that speaks a network protocol for credential audiences: `builtin` (WebDAV + SFTP in-process) or `sftpgo` (external).
- **File gateway** — the host-side authority every live access goes through: grant lookup, policy intersection, path resolution, confinement, sensitive-file floor, audit.
- **File-sharing policy** — limits on what may be shared. A local policy (settings) and, for org members, an org policy; the effective policy is their intersection.

---

## 3. Architecture

```text
Conversation (ChatSession)
 ├─ execution binding (ADR-0111 Bundle leases) ─┐
 ├─ workspace (Project.roots) ──────────────────┤
 ├─ session assets (Dexie messageMedia) ────────┼─► FileSpace resolver (lib/filespace, pure)
 └─ artifacts (Dexie) ──────────────────────────┘        │
                                                         ├─► UI: dock "Files" panel, links, pickers
                                                         ├─► Snapshot share (lib/share + share-server blobs)
                                                         └─► mount sync ─► host file gateway (crates/cognia-file-share)
                                                                              ├─ live grants / credentials / audit (file-share.sqlite)
                                                                              ├─ builtin provider: WebDAV listener + SFTP listener
                                                                              ├─ sftpgo provider: REST user/folder provisioning
                                                                              └─ collab host-request responder ◄─ collab-server request channel
```

Ownership:

- **Conversation** owns the resources (lifecycle cascades start from session events).
- **FileSpace** owns the logical view (pure TypeScript, shared by the WebView and the headless brain, which runs the same `lib/` code against `cognia-server`).
- **Storage** stays where it is: disk roots (worktrees, shadows, managed directories, project checkouts) and Dexie.
- **Share links** own snapshots; **live grants** own online access; **the gateway** enforces both online paths; **providers** only speak protocols.

---

## 4. Data model

### 4.1 FileSpace (TypeScript, derived) — `types/filespace/index.ts`

```ts
export type FileSpaceMountId = "workspace" | `root:${string}` | "uploads" | "artifacts"

export type FileSpaceMountStatus = "available" | "offline" | "missing" | "deleted"

export interface FileSpaceMount {
  id: FileSpaceMountId
  /** Stable virtual prefix: "/workspace", "/roots/<logicalRootId>", "/uploads", "/artifacts". */
  virtualPath: string
  backing: "disk" | "dexie"
  /** Absolute host path for disk mounts; absent for Dexie mounts. */
  hostPath?: string
  /** Path a sandbox container sees for hostPath, when a Docker connection maps it. */
  containerPath?: string
  /** True when hostPath is a managed worktree/shadow rather than the user's checkout. */
  managed: boolean
  role?: "primary" | "additional"
  logicalRootId?: string
  writable: boolean // dexie mounts: always false
  status: FileSpaceMountStatus
  /** Why status is not "available" — rendered, never guessed. */
  statusReason?: "no-fs-backend" | "host-offline" | "managed-missing-on-device" | "managed-deleted"
}

export interface ConversationFileSpace {
  sessionId: string
  /** Aggregate: available if any mount is available; deleted when the session is gone. */
  status: "available" | "offline" | "deleted"
  mounts: FileSpaceMount[]
  /** Host that owns the disk mounts: "local" or a remote execution host id (ADR-0082 routing). */
  hostId: string
}

/** A path inside a FileSpace: "/workspace/src/a.ts". Always POSIX, absolute, normalized. */
export type FileSpacePath = string & { readonly __brand: "FileSpacePath" }
```

### 4.2 Snapshot share additions (TypeScript)

`lib/share/types.ts`:

```ts
export interface ShareFileEntry {
  /** Opaque per-share blob id (random 16 bytes, base64url). */
  blobId: string
  /** FileSpace path at share time, e.g. "/workspace/report.pdf". */
  path: string
  name: string
  mime: string
  size: number
  sha256: string // of plaintext
  chunkSize: number
  chunkCount: number // 0 for an empty file, which uploads no blob
  /** Per-blob random 8 bytes (base64) that prefix every chunk IV. */
  ivPrefix: string
}

export interface SharePayload {
  // …existing fields…
  /** Present when the share carries files; inside the ciphertext like everything else. */
  files?: ShareFileEntry[]
}
```

New kind `file-bundle` for "share these files" without messages. Chat kinds gain `files` when the user selects files, and gain resolved images (see §6.4).

`lib/db/shared-links.ts` row gains `files?: { path: string; size: number; sha256: string }[]` and `sessionId?: string` (no index change → no schema bump; Dexie stores the object). The manifest exists so "what did I share from this conversation" is answerable without decrypting.

### 4.3 Host store — `crates/cognia-file-share`, `file-share.sqlite`

Separate SQLite file beside `companion-signaling.sqlite` (desktop: app data dir; headless: `cognia-server` data dir), per account (ADR-0215 account directories). Covered by the companion backup walk (verify in P2).

```sql
CREATE TABLE file_space_mounts (       -- last mount table pushed by the renderer/brain
  session_id TEXT NOT NULL,
  mount_id TEXT NOT NULL,
  virtual_path TEXT NOT NULL,
  backing TEXT NOT NULL CHECK (backing IN ('disk','dexie')),
  host_path TEXT,
  writable INTEGER NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  session_state TEXT NOT NULL CHECK (session_state IN ('active','archived','deleted')),
  collab_session_id TEXT,              -- bound shared session, when any
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, mount_id)
);

CREATE TABLE file_grants (
  id TEXT PRIMARY KEY,                 -- fg_<ulid>
  session_id TEXT NOT NULL,
  created_by TEXT NOT NULL,            -- 'user' | 'agent'
  creator_principal TEXT NOT NULL,     -- local account id or usr_ id
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('credential','collab')),
  audience_json TEXT NOT NULL,         -- {protocols:[...]} | {collabSessionId, userIds?, minRole}
  permissions TEXT NOT NULL,           -- JSON array subset of ["read","download","write"]
  status TEXT NOT NULL CHECK (status IN ('active','suspended','stale','expired','revoked')),
  status_reason TEXT,
  expires_at INTEGER NOT NULL,         -- live grants always expire (policy max TTL)
  approval_receipt_id TEXT,            -- action-review receipt when an approval was required
  policy_revision INTEGER NOT NULL,    -- effective policy revision at creation
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX file_grants_session ON file_grants(session_id, status);

CREATE TABLE file_grant_paths (
  grant_id TEXT NOT NULL REFERENCES file_grants(id) ON DELETE CASCADE,
  mount_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,              -- normalized, '' = whole mount
  is_dir INTEGER NOT NULL,
  mount_fingerprint TEXT NOT NULL,
  PRIMARY KEY (grant_id, mount_id, rel_path)
);

CREATE TABLE file_credentials (
  id TEXT PRIMARY KEY,                 -- fc_<ulid>
  grant_id TEXT NOT NULL REFERENCES file_grants(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('webdav','sftp')),
  provider TEXT NOT NULL CHECK (provider IN ('builtin','sftpgo')),
  username TEXT NOT NULL UNIQUE,       -- cg-<10 base32>
  password_hash TEXT,                  -- argon2id PHC string (builtin only)
  ssh_public_key TEXT,                 -- optional SFTP key auth (OpenSSH format)
  provider_account_id TEXT,            -- SFTPGo username when provider = sftpgo
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE file_auth_failures (       -- persisted backoff
  key TEXT PRIMARY KEY,                -- sha256(username|ip)
  failures INTEGER NOT NULL,
  locked_until INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL
);

CREATE TABLE file_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  session_id TEXT,
  grant_id TEXT,
  principal TEXT NOT NULL,             -- 'owner' | 'credential:<username>' | 'collab:<usr_id>' | 'agent:<sessionId>'
  channel TEXT NOT NULL,               -- 'app' | 'webdav' | 'sftp' | 'sftpgo' | 'collab'
  action TEXT NOT NULL,                -- grant.create|grant.revoke|grant.expire|grant.stale|credential.issue|credential.rotate|fs.list|fs.read|fs.write|fs.delete|fs.rename|fs.mkdir|auth.fail
  path TEXT,
  bytes INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','failed')),
  reason TEXT,
  remote TEXT                          -- client IP (credential channels) or device id
);
CREATE INDEX file_audit_session ON file_audit(session_id, at);
```

Retention: audit 90 days (setting), pruned by the existing 24-hour host maintenance tick.

### 4.4 Collab-server (Postgres)

As built, P1's `migrations/0014_file_sharing.sql` holds only
`org_file_sharing_policies` (ids are `text`, matching `orgs(id)`; `revision`
starts at 1 on the first save and an org with no row is served the defaults at
revision 0; `updated_at` is epoch milliseconds like the plane's other tables).
`session_file_hosts`, `session_file_grants` and `host_file_requests` landed in
P3 as `migrations/0015_session_files.sql` (text ids, epoch-millisecond times,
composite foreign keys to `chat_sessions(org_id, id, workspace_id)`, `min_role`
admitting `owner`, request statuses with `awaiting_upload`, upload length and
SHA-256 declared up front). Bytes use request-scoped object keys, so the
attachment store gained no `audience_user_id`/`expires_at` columns. See §8.4.
The sketch below is the original design:

`migrations/0014_file_sharing.sql`:

```sql
CREATE TABLE org_file_sharing_policies (
  org_id UUID PRIMARY KEY REFERENCES organizations(id),
  allow_public_snapshots BOOLEAN NOT NULL DEFAULT TRUE,
  allow_live_grants BOOLEAN NOT NULL DEFAULT TRUE,
  allow_protocol_credentials BOOLEAN NOT NULL DEFAULT FALSE,
  allow_live_write BOOLEAN NOT NULL DEFAULT FALSE,
  allow_agent_sharing BOOLEAN NOT NULL DEFAULT FALSE,
  max_snapshot_ttl_seconds INTEGER NOT NULL DEFAULT 2592000,
  max_live_ttl_seconds INTEGER NOT NULL DEFAULT 604800,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);  -- RLS ENABLE + FORCE on org_id like every tenant table

CREATE TABLE session_file_hosts (        -- the authenticated host of a shared session's files
  session_id UUID PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  org_id UUID NOT NULL,
  registered_by TEXT NOT NULL,           -- usr_ id holding FilesShare
  host_token_hash BYTEA NOT NULL,        -- sha256 of a 32-byte host token
  host_label TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE session_file_grants (        -- mirror of host grants with audience 'collab'
  id TEXT PRIMARY KEY,                    -- same fg_ id as the host row
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  org_id UUID NOT NULL,
  user_ids TEXT[],                        -- NULL = every member meeting min_role
  min_role TEXT NOT NULL CHECK (min_role IN ('viewer','member','maintainer')),
  permissions TEXT[] NOT NULL,
  paths JSONB NOT NULL,                   -- [{mountId, relPath, isDir}]
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  policy_revision BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE host_file_requests (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  org_id UUID NOT NULL,
  grant_id TEXT NOT NULL REFERENCES session_file_grants(id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('list','stat','read','write','mkdir','delete','rename')),
  path TEXT NOT NULL,
  dest_path TEXT,
  upload_attachment_id UUID,              -- requester-supplied bytes for 'write'
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','done','failed','expired')),
  result JSONB,                           -- listing/stat result (bounded)
  result_attachment_id UUID,              -- bytes for 'read'
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL         -- 120 s for pending; result blobs 15 min
);
```

The attachment store gains `audience_user_id TEXT NULL` and `expires_at TIMESTAMPTZ NULL` (ephemeral, requester-only objects; reaped by the existing attachment cleanup). `SessionAction` (Rust `chat.rs` and TS `session-permissions.ts`, pinned by a new parity test) gains `FilesShare` (owner, maintainer), `FilesReadLive` (all roles incl. viewer, subject to grant) and `FilesWriteLive` (owner, maintainer, member; never guest).

### 4.5 Share server (Rust axum + Cloudflare Worker, same `/v1` contract)

New constants in `share-constants.json` (both suites assert them): `blobChunkBytes` (4 MiB), `maxBlobBytes` (512 MiB per file), `maxShareBlobBytes` (2 GiB per share), `maxBlobsPerShare` (200), `readTicketTtlSeconds` (3600).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| PUT | `/v1/share/{code}/blobs/{blobId}/{index}` | `X-Owner-Token` | Upload one encrypted chunk (≤ chunk size + 16-byte tag). Idempotent per index. Counts against per-share quota. |
| POST | `/v1/share/{code}/blobs/{blobId}/commit` | `X-Owner-Token` | `{chunkCount, totalBytes}`; verifies all chunks present; blob becomes readable. |
| GET | `/v1/share/{code}/blobs/{blobId}/{index}` | `X-Read-Ticket` | Download one chunk. |
| GET | `/v1/share/{code}` | public | Unchanged envelope read; response gains `readTicket` (HMAC over code + expiry, server key) so a burn-after-read share's files remain downloadable for one ticket lifetime after the single counted view. |

Blobs are deleted with the share (revoke, expiry reaper, org delete). The server stays blind: chunk ciphertext only, no names or sizes beyond byte counts.

---

## 5. P0 — FileSpace and file links

### 5.1 Resolver — `lib/filespace/`

- `resolve.ts` — `resolveConversationFileSpace({ session, projects, sandboxMounts, transportState, hasFsBackend })`, pure. Mount derivation:
  1. `execution.roots[]` leases when present: the primary lease is `/workspace`, each additional lease is `/roots/<logicalRootId>`; `managed` from `resolveExecutionRoot`'s rule.
  2. Otherwise the workspace's roots (`Project.roots`): primary `/workspace`, others `/roots/<root.id>`.
  3. `/uploads` when the session has session assets; `/artifacts` when it has artifacts. Both `backing: "dexie"`, `writable: false`.
  4. `containerPath` via the Docker connection's `workspaceMount` and the existing `containerPathFor` (`lib/sandbox/docker-policy-attestation.ts`).
  5. Status from `managedWorkspace.availability`, the remote-host transport state (ADR-0082 routing) and `hasWorkspaceFsBackend()`.
  6. *Built differently (P0):* there is no `runtime-ephemeral` reason — container runtimes mount the host directory, so a rebuilt or ephemeral container never takes a mount offline. `remote-sandbox` (a session placed on an ADR-0221 remote provider, whose live tree is a remote clone) is added once that ADR exposes a per-session placement to read; with no producer yet, no type carries it.
  The resolver reuses `resolveSessionWorkspaceRoot`/`primaryRootOf`; it never re-derives the chain.
- `paths.ts` — `normalizeFileSpacePath` (POSIX, rejects `..`, NUL, backslashes, drive letters, empty segments; NFC-normalizes), `locateFileSpacePath(space, path) → { mount, relPath } | null`, `toFileSpacePath(space, absoluteHostPath)` (inverse; deepest mount wins).
- `sources.ts` — Dexie readers for the two Dexie mounts: `listSessionAssets(sessionId)` and artifacts by `sessionId`, producing `FileSpaceEntry` rows (`name`, `size`, `mime`, `updatedAt`, `sourceRef`).
- `open.ts` — `openFileSpacePath({ sessionId, path, line, column })`: disk mount → `revealWorkspaceFile` with that mount's root (multi-root aware, unlike the current execution-root-only seam); `/uploads/<name>` → the attachment preview; `/artifacts/<id>` → artifact panel. Returns a typed result (`opened` | `not-found` | `outside` | `no-backend` | `offline`) so callers can toast precisely.
- `links.ts` — `buildConversationFilesLink({ sessionId, path?, line?, desktop })`:
  - desktop: `cognia://session/<id>?view=files[&path=<enc>][&line=n]` (extends `buildSessionDeeplink`, same path-safe rule);
  - web/app: `/?session=<id>&view=files[&path=…][&line=…]` (extends `buildSessionHref`).
  `parseConversationFilesLink(params)` is the inverse.

`hooks/filespace/use-conversation-filespace.ts` subscribes to the session row, project store, assets and artifacts, and returns the live `ConversationFileSpace`.

### 5.2 Links

- `parseCogniaDeeplink`: `open_session` gains `view?: "files"`, `path?: FileSpacePath`, `line?: number`. Unknown `view` values are ignored (not an error) so older/newer links degrade to opening the session.
- `dispatchDesktopDeeplink`: keep the synchronous `openSession` before any `await`, then `openFileSpacePath` when `view === "files"`; with no `path`, reveal the Files panel.
- Web/app root: extend `useSessionLink` to read `view`/`path`/`line`, strip them with `router.replace` after handling (same as the permalink consumer).
- Capacitor: `dispatchRoute` opens the session and ignores file fields (no fs backend on mobile). Dormancy labelled on three axes: the route type documents it, the mobile session view shows nothing extra, a test pins that file fields are ignored.
- CLI: `cognia open session <id> --files [--path <p>] [--line <n>]` in `crates/cognia-cli/src/commands/open.rs`, mirroring the grammar; Rust and TS parsers pinned by shared fixture cases.
- Race: `revealIntent` carries no session id. `openFileSpacePath` passes `sessionId` through `revealWorkspaceFile` (which already carries it) and the Files panel ignores a reveal whose session is not active. Tested explicitly.

### 5.3 UI

- New dock panel `files` ("Conversation files", `components/filespace/`), registered in `chat-dock-panels.tsx` and `dock-panel-meta.ts` for sessions:
  - mount list with status/reason, managed badge, host path, container path;
  - disk mounts open in the existing workspace editor — its root switcher already exists; a new `revealWorkspaceRoot` dock action roots the editor at any mount without opening a file;
  - Dexie mounts list uploads/artifacts with preview/open;
  - per-entry "Copy link" (internal link) and "Reveal";
  - a "Sharing" section placeholder is **not** shipped in P0 (no dormant control).
- "Copy link to file" added to the project file tree context menu (`project-file-tree.tsx`) and the tool-card file link menu (`file-tool-part.tsx`).
- i18n namespace `filespace` under `i18n/messages/{en,zh-CN}/filespace.json`.

### 5.4 P0 tests

Resolver (lease/project/managed/offline/container mapping/legacy rows), paths (escape vectors, NFC, Windows forms), link build/parse round-trips (desktop/web/CLI fixtures), deep-link parser and dispatcher cases, `useSessionLink` stripping, mobile ignore, open.ts results, panel rendering and actions, file-tree/tool-card menu items, race test for reveal across session switch. Regression: existing deep-link, permalink and edit-review-bridge suites unchanged.

---

## 6. P1 — Snapshot shares with files

### 6.1 Crypto

- Per-file key: `HKDF-SHA256(ikm = share key material, salt = blobId bytes, info = "cognia-share-blob-v1")` → 32-byte AES-GCM key. The key material is the link's raw key, or for a passphrase share the PBKDF2 output (`deriveBits`, 600k iterations) derived once per share, so a blob is unreadable without the passphrase too. The envelope key derived from the same material is unchanged, so existing passphrase links still open.
- Chunk `i` (4 MiB of plaintext, plus the 16-byte GCM tag): IV = the blob's 8-byte `ivPrefix` (random, carried in the manifest) ‖ uint32BE(i); AAD = `utf8(code) ‖ 0x00 ‖ utf8(blobId) ‖ 0x00 ‖ uint32BE(i) ‖ uint32BE(chunkCount)`. Reordering, truncation and cross-share splicing fail authentication. Plaintext SHA-256 is verified after reassembly against the manifest.
- Streaming: chunks are read from the source (the new ranged host command `fs_read_workspace_file_chunk`, companion `fs.workspace_file.read_chunk`, ≤ 4 MiB per call, for disk mounts; Dexie blobs via `Blob.slice`) and uploaded with bounded concurrency (3) and retry (408/425/429/5xx, 4 attempts). Memory stays O(chunk).
- Two passes. The manifest's `sha256` must be inside the envelope, and the envelope must exist before any chunk can be uploaded, so the client first streams each file to hash it, then creates the share, then streams it again to encrypt and upload, re-hashing as it goes. A file whose bytes changed between the passes is refused (`ShareFileChangedError`) and the share is withdrawn.

### 6.2 Server

Endpoints in §4.5, implemented twice: Rust (`services/share-server/src`, blobs on disk under the data dir, quota rows in SQLite inside the same `BEGIN IMMEDIATE` discipline) and Worker (R2 keys `share/<code>/blob/<blobId>/<i>`, quota in the `ShareLifecycle` DO). Read tickets are HMAC with a server key (`SHARE_TICKET_KEY`, generated if unset on the Rust side; Worker secret). Parity tests extend `tests/constants_parity.rs`, `http_endpoints.rs`, `lifecycle.rs` and the Worker suite. The reaper deletes blob prefixes.

### 6.3 Client

- `lib/share/blobs.ts` — encrypt/upload/commit and download/decrypt/verify, with progress callbacks and abort.
- `lib/share/file-selection.ts` — expand a FileSpace selection (files and directories) into entries, apply ignore rules (`.gitignore`-aware walk already in `fs_walk_workspace`), the sensitive floor (§9.3), size totals and policy limits; directories are snapshotted as their current file list.
- `createShareLink` gains an `files` option: create the share (envelope with manifest), upload blobs, commit; on any failure, revoke the share so no half-share stays live. As built: the withdrawal is the owner-token `DELETE`; if that also fails the link is still recorded in My Shares so it can be revoked by hand, and the error says which happened (`ShareFilesUploadError.revoked`). Cancelling withdraws the same way.
- Viewer (`components/share/payload-view.tsx` → `share-files-section.tsx`): a files section for any payload with `files` — list, per-file download (decrypt in the browser, `Blob` save), inline preview for images (a `blob:` URL; SVG is download-only), PDFs (`<object type="application/pdf">` over a `Blob` whose type is pinned, never the file's claimed MIME) and text (a plain `<pre>`, capped). `file-bundle` renders the list alone. As built, the ADR-0124 viewer registry is not used: it renders host paths through host-owned reads, and the share viewer is an anonymous static page with neither. Downloads decrypt chunk by chunk into a `Blob`; a `ReadableStream` would not lower peak memory because the `Blob` holds the whole file either way.
- Dialogs: `ShareLinkDialog` gains a Files section (FileSpace picker with checkboxes, totals, sensitive-file opt-in); the single-export chat share and a new "Share files…" action in the Files panel use it. `MySharesPanel` shows file counts and the source conversation.
- Images in chat shares: `buildChatShare` (renamed from `buildChatSharePayload`; it returns the payload and the attachments) materializes `cognia-media:` references through `materializeChatShareMedia` (`lib/share/chat-media.ts`): images up to 1 MiB are inlined as `data:` URLs within a 3 MiB budget per share (the envelope is one request under the server's 10 MiB cap); the rest are carried as file blobs under `/attachments/<name>` and appear in the viewer's files section, the transcript naming them; media no longer stored on the device are shared by name and counted (`unavailableMedia`), which the dialog reports. Fixes the unresolved-image bug for every chat share, not only those with files.
- `includeAllBranches` is passed through (currently dropped).

### 6.4 Policy

- Local policy `AppSettings.fileSharing` (`allowPublicSnapshots`, `allowLiveGrants`, `allowProtocolCredentials`, `allowLiveWrite`, `allowAgentSharing`, `maxSnapshotTtlSeconds`, `maxLiveTtlSeconds`) with conservative defaults (protocol credentials, live write and agent sharing off). Settings card under Settings → Data (`components/share/file-sharing-policy-card.tsx`, next to the share server card), which also shows the org policy, editable by owners and admins and read-only to members. The live, credential, write and agent fields have no surface until P2/P3; they are stored, enforced by the plane, documented as dormant on the type and labelled "Not available yet" in the card.
- Org policy: collab-server `GET /v1/orgs/{org}/file-sharing-policy` (any member) and `PUT` (org owner/admin, bumps `revision`, writes `authorization_audit_events`). Client `lib/collab/file-sharing-policy.ts` caches by revision. `lib/filespace/policy.ts` computes the effective policy = field-wise most restrictive of local and org (org absent → local only).
- Collab-bound conversations: sharing files requires `FilesShare` via the server (`authorizeSessionExport` gains a `scope: "files"` variant); denial maps to the existing not-found/forbidden UX. As built: `GET …/export-authorization?scope=files` checks `files.share` and the org's `allow_public_snapshots`, audits a policy denial with reason `org_file_sharing_policy`, and answers with `x-cognia-file-policy-revision` so a client holding an older cached policy refetches it. The effective policy fails closed: if the account's org (or whether it has one) cannot be read, snapshots with files are refused.

### 6.5 P1 tests

Crypto vectors (HKDF, chunk AAD tamper/reorder/truncate), blob client with a fake server, selection expansion (ignore rules, sensitive floor, limits), payload builder (image materialization), viewer (files section, burn-after-read ticket path), dialogs, policy intersection, share-server Rust tests + Worker tests + parity, collab-server policy endpoint tests and `SessionAction` parity. Regressions: existing share kinds round-trip unchanged; existing share-server lifecycle suite green.

---

## 7. P2 — Live grants and network drives

### 7.1 Crate `crates/cognia-file-share` (platform layer)

Depends on `cognia-files` (confinement primitives), `cognia-secrets`, `cognia-net` (SFTPGo client via `managed_client`), `cognia-companion-security` (not required; kept independent). `tauri-host` feature for commands. Added to `scripts/gates/rust-architecture.json`.

Modules: `store.rs` (schema above, migrations by marker), `mounts.rs` (mount table sync + fingerprints), `policy.rs` (effective policy snapshot pushed from TS, clamps), `gateway.rs`, `credentials.rs` (generation, argon2id at the same parameters as `account_auth` — m=19456 KiB, t=2, p=1 — moved into a shared helper, constant-time compare via `subtle`), `backoff.rs` (persisted, keyed by username+IP: 5 free failures, then 30 s doubling to 15 min, reset after 30 min clean), `audit.rs`, `provider.rs` (trait), `builtin/dav.rs`, `builtin/sftp.rs`, `sftpgo.rs`, `listener.rs`, `maintenance.rs`, `commands.rs` (tauri-host).

### 7.2 Gateway

`authorize(principal, grant_id?, op, virtual_path) -> Result<Target, Denial>`:

1. Grant lookup (`active`, unexpired, audience matches principal, op ⊆ permissions; `download` required for byte reads on credential audiences; `write` for mutations).
2. Mount lookup from `file_space_mounts`; `session_state == active`; mount `available`; fingerprint equals the grant path's recorded fingerprint, else mark grant `stale` (audit `grant.stale`) and deny.
3. Effective policy check at its current revision (live write, protocol credentials), so a policy tightened after grant creation takes effect immediately.
4. Path: normalize (same rules as `paths.ts`, mirrored and fixture-tested), ensure it is within a granted `(mount_id, rel_path)` prefix, then resolve against `host_path` through `cognia-files`' `resolve_workspace_target` (canonicalize root and target, `starts_with`), `reject_symlinked_final` for writes/renames, and a parent-chain check for not-yet-existing targets. Case-insensitive volumes compare on canonicalized paths.
5. Sensitive floor (§9.3): denied for every live channel, regardless of grant.
6. Audit the decision.

Dexie mounts are served read-only through the existing host data plane (`DataPlane::pick` → bridge to the renderer/brain), with a new chunked bridge op (`filespace.readAssetChunk`), because `MAX_MEDIA_BYTES` (10 MiB, buffered) is too small for session uploads (≤ 500 MiB).

### 7.3 Built-in provider

- **Listener** — own router and own port(s), outside `build_router_for_mode` (no 64 KiB body cap, no drain-as-mutation, no loopback trust). Defaults: off; WebDAV `127.0.0.1:27893`, SFTP `127.0.0.1:27894`. Exposure modes: `loopback` (local mounts; also the origin for a tunnel), `lan` (bind 0.0.0.0; WebDAV over HTTPS with the companion certificate, SFTP with a persistent Ed25519 host key whose fingerprint the UI shows), `tunnel` (a named cloudflared ingress to the WebDAV origin; requests with `CF-Connecting-IP` use that IP for backoff and audit). Headless: same, with Caddy in `deploy/compose` as the TLS front for WebDAV.
- **WebDAV** — `dav-server` with a custom `DavFileSystem` whose every operation calls the gateway; Basic auth middleware (credential → grant), failed-auth-only rate charging, `WWW-Authenticate` preserved, streaming bodies, `LOCK` via `dav-server`'s in-memory lock system scoped per grant, `Content-Disposition` for downloads. The virtual root of a credential is its grant: top-level entries are the granted mounts/paths only.
- **SFTP** — `russh` server + `russh-sftp` handler routing through the gateway; password or public-key auth; one subsystem only (`sftp`), no shell/exec/forwarding channels (rejected), so ADR-0162's "SFTP is shell-equivalent" does not apply: this SFTP is confined to the grant.
- **Revocation** — revoking a grant or credential, or the grant going stale/expired/suspended, drops live WebDAV/SFTP sessions for it (connection registry keyed by grant id).

### 7.4 SFTPGo provider

- Configuration (Settings → Connectivity → Network drive, headless config file/env): base URL, admin API key (stored with `cognia_secrets::secret_store` service `com.cognia.file-share`, account `sftpgo-admin`), path mapping list `{ hostPrefix, sftpgoPrefix }` (SFTPGo usually sees the workspaces volume at a different path), public endpoint hints for the UI.
- Provisioning per credential: create SFTPGo user `cg-<…>` with the one-time password (sent once, never stored by Cognia), `expiration_date` = grant expiry, one virtual folder per granted path (mapped through the path list; unmappable → fail closed with `sftpgo-path-unmapped`), per-folder permissions (`list,download` / `+upload,overwrite,delete,rename,create_dirs` for write), `filters.denied_patterns` from the sensitive floor, `filters.allowed_ip` when the grant restricts IPs.
- Revoke/suspend → delete/disable user and folders; stale/expire via maintenance. Health via `/healthz`; status shown in Settings.
- Egress: Rust client via `managed_client`; loopback targets need an entry in `scripts/gates/network-egress-allowlist.json` (`reason: "loopback"`).
- Deployment: `deploy/compose/compose.sftpgo.yaml` declaring `sftpgo` with the shared workspaces volume, documented in the deploy docs. AGPL-3.0 noted: SFTPGo is deployed as a separate, unmodified service and never bundled into the desktop app.

### 7.5 Renderer / brain side

- `lib/filespace/host-sync.ts` — push mount tables for sessions with grants (and on session/workspace changes) via `file_space_sync`; push the effective policy snapshot. Same pattern and wiring point as `allowed-roots-sync.ts`.
- `lib/filespace/grants-client.ts` — typed wrappers for `file_grant_create/list/revoke/rotate_credential/suspend/resume`, `file_share_status`, `file_audit_list`.
- UI: "Share live…" dialog (paths from the FileSpace picker, permissions, expiry ≤ policy, audience: credential with protocols, or collab members in P3); result card shows endpoint URLs, username, one-time password, SFTP host-key fingerprint, and Finder/Windows/rclone instructions; grant list in the Files panel "Sharing" section and a global "Live file access" list in Settings with revoke/rotate and audit view.
- Paired devices: grant management commands are added to the companion command manifest as control-gated; regenerate contracts.

### 7.6 P2 tests

Rust in-file tests: store migrations, gateway decision table (every denial reason), path escape (`..`, encoded, symlink to outside, symlinked parent, hardlink note, NFC/NFD, case folding), sensitive floor, fingerprint stale, policy tightening, backoff persistence, credential hashing/verification, revocation drops connections. Integration: WebDAV via `reqwest` (PROPFIND/GET/PUT large streamed/MKCOL/MOVE/COPY/DELETE/LOCK) against a temp root; SFTP via `russh` client; SFTPGo provider against a mock HTTP server (request shapes, unmappable path, revoke). TS: host-sync, grants-client, dialogs. Gates: `audit:rust-architecture`, network-egress, companion command manifest. Manual: `tauri-smoke`, Finder + Windows + rclone mount spike (§12).

### 7.7 As built (P2)

Where P2 differs from §7.1–§7.5, and what it added that the plan did not foresee:

- **Modules.** No `provider.rs` trait and no `maintenance.rs`: the built-in provider keeps a hashed password while SFTPGo keeps a provisioned user, so they share less than a trait would imply; maintenance (expiry, policy re-check, the SFTPGo retry queue, mount pulls) runs on one timer in `service.rs`. `page.rs` adds kind-tagged cursors on top of `cognia_problem::paging`, and `rpc.rs` is the one command surface (below).
- **Commands.** Thirteen `file_*` commands in `rpc.rs`, dispatched by the Tauri shells (`commands.rs`, `tauri-host`) and by the companion family `src-tauri/src/companion_api/rpc/file_share.rs`, so the manifest rows, request/response schemas and the dispatch arms are generated or checked from one place. `file_share_activate`, `file_space_sync`, `file_share_policy_set` are `target: service` (host-only); reads are `host.observe` with page tokens (grants 50/200, audit 100/500; legacy `limit` refused); grant changes are `workspace.write` control commands; listener and SFTPGo settings are `host-admin` + step-up. Audit principal: `owner` for the app, brain and service scope, `device:<id>` for a paired device.
- **Mount tables are also pulled.** A grant made from a paired device has no WebView to push fresh paths, so the host asks over the desktop bridge (`companion://filespace-mounts-request` → `SessionMountsInput`) on every create and resume, and every minute for conversations with grants; the brain answers the same frame when it announces the `filespace` capability. A failed pull keeps the last table; an answer for another session is refused. Dexie bytes come back over the media channel in ≤ 4 MiB slices (`companion://filespace-asset-request`), replacing the planned `filespace.readAssetChunk` op.
- **Shareable roots.** The allowed-roots registry was too wide (it holds app data and `~/.claude`), so disk mounts are validated by `is_shareable_workspace_path`: active project roots or the managed execution directory under the data dir on the desktop, `SpawnPolicy::validate_workspace_root` on headless.
- **Account binding.** The host is authoritative: `AccountSecuritySession` binds the unlocked account on unlock and unbinds on lock (`bind_account`, generation-ordered, last binding wins); `activate` from the renderer may only confirm it (`file_share_locked` otherwise), and re-confirming the served account keeps listeners and connections. Headless binds its local account at boot.
- **Endpoints.** `SftpgoStatus` carries the endpoints SFTPGo-served credentials dial, and an empty set says why (`sftpgo_no_public_endpoint`); a rotated password's card uses the provider's endpoints from the status.
- **Process registry.** `ManagedSubsystem::FileShare` rows for the WebDAV and SFTP listeners (in-process) and the cloudflared child, with kill = shutdown and restart = restart listener.
- **UI.** `components/filespace/live-share-dialog.tsx` (reuses `ShareFilesPicker`), `live-share-credentials.tsx` (Finder / Windows / rclone / OpenSSH steps from `lib/filespace/mount-instructions.ts`), `live-grants-list.tsx`, `live-share-audit.tsx`, `live-sharing-section.tsx` in the Files panel; Settings → Connectivity gains a **Network drive** panel (`network-drive-block`, `sftpgo-block`, `live-access-block`). The live policy fields lost their "not available yet" badge; agent sharing keeps it until P3.
- **Spikes (§12).** Run on macOS with the ignored `spike_serve_real_clients` and `spike_real_sftpgo` tests: curl and Finder (`mount volume`) against loopback WebDAV, OpenSSH `sftp` against the SFTP listener (including the sensitive floor and confinement), and the SFTPGo round trip (create, suspend, resume, rotate, revoke). Not run, for want of the clients here: Windows WebClient, rclone, Cyberduck, WinSCP, LAN HTTPS with Finder, the cloudflared tunnel. The automated coverage is the in-crate WebDAV (`reqwest`) and SFTP (`russh` client) tests and the SFTPGo mock server.

---

## 8. P3 — Collaboration members, agent tools, lifecycle hardening

### 8.1 Collab member live access

- **Host registration** — a member with `FilesShare` registers the device holding the files for a shared session: `POST /chat-sessions/{id}/file-host` returns a 32-byte host token (stored hashed); the host keeps it in `secret_store` (service `com.cognia.file-share`, account `collab-host:<sessionId>`). Re-registration replaces it (one host per session).
- **Grants** — creating a live grant with a `collab` audience writes the host row and mirrors it to `session_file_grants` (owner/maintainer with `FilesShare`; policy clamp server-side too). Revocation updates both; the mirror is authoritative for members' listing, the host row for serving.
- **Requests** — a member calls `POST /chat-sessions/{id}/file-requests` (`FilesReadLive`/`FilesWriteLive` + a covering, unexpired, unrevoked mirror grant). The server appends a notification event `file_request.created` on the session stream. The host (desktop renderer coordinator; headless brain responder — read/write answering is not autonomous action, the brain's reader-only rule is amended for this one handler) claims with its host token, executes through the gateway with principal `collab:<usr_id>` (the host re-checks the grant locally — never trusts the server alone), and posts the result: listings/stat as bounded JSON, file bytes into a requester-only ephemeral attachment (`audience_user_id`, `expires_at` 15 min), writes by pulling the requester's upload attachment. Requests expire after 120 s unclaimed.
- **Member UI** — the shared-session panel gains a Files tab: browse/download/upload through requests, with "host offline" when nothing claims.

### 8.2 Agent tools — `lib/claude/filespace-builtin-tools.ts`

Following the artifact family pattern (manifest + runner + `isFilespaceBuiltinTool`, dispatch branch in `plugin-tool-ipc.ts`, gated injection in `build-options.ts`, rules in `lib/claude/permissions/filespace-tool-rules.ts` keyed bare and `mcp__cognia-plugin-tools__…`):

| Tool | Rule | Notes |
| --- | --- | --- |
| `filespace_list` | allow | Mounts, entries under a path (bounded), and this conversation's shares/grants. |
| `filespace_share` | ask | `{ paths, mode: "snapshot" \| "live", permissions, expiresInSeconds, audience? }`. Snapshot returns the share URL; live returns grant id and, for credential audiences, endpoint + username only. |
| `filespace_revoke_share` | allow | Revokes a share link or live grant **of this conversation**. |
| `filespace_enable_webdav` | ask | Convenience for a live credential grant with the `webdav` protocol. |
| `filespace_disable_webdav` | allow | Revokes this conversation's WebDAV credential grants. |

Invariants: the session is the calling session (`context.sessionId`, non-empty or the call fails — no active-session fallback); paths must resolve inside this conversation's FileSpace; the sensitive floor applies with no agent override; secrets (passwords, share keys beyond the URL the user will see anyway) are shown to the user in the approval result UI and never returned to the model; "allow always" is not persistable for `share`/`enable` (rule metadata `persistable: false`, honoured by `deriveAllowRuleFromApproval`); `share`/`enable` are injected only when the effective policy has `allowAgentSharing`, list/revoke/disable whenever the conversation has a FileSpace. High-risk mapping: public snapshots and credential grants classify as `external-send` in `lib/policy/risk/classify-risk.ts`.

### 8.3 Lifecycle

| Event | FileSpace | Snapshot shares | Live grants | Providers / credentials |
| --- | --- | --- | --- | --- |
| Session deleted | `deleted` | Kept (independent encrypted copies); My Shares shows "conversation deleted"; the delete dialog offers "also revoke N shares" | Revoked `session_deleted` in `deleteSessionsWithTeardown` post-commit (host path reuses it) | Sessions dropped; SFTPGo users deleted; collab mirror revoked; host token cleared |
| Session archived / unarchived | unchanged | Kept | `suspended` / resumed if unexpired, via the routed archive writer | SFTPGo users disabled / enabled |
| Fork / branch | the new session's own | not copied | not copied | — |
| Moved workspace / rebound execution / managed workspace pruned | re-resolved | unaffected | `stale` until the owner reconfirms (fingerprint) | disabled |
| Container rebuilt | same mounts (containers mount the host directory) | — | transparent | — |
| Host offline | `offline` | unaffected | denied (503 for protocols; collab requests expire) | built-in down; server-side SFTPGo continues only for mounts it sees |
| Share revoked / expired | — | server deletes envelope and blobs | — | — |
| Grant revoked / expired | — | — | denied immediately; maintenance marks expired | sessions dropped; SFTPGo user deleted |
| Account locked / switched | — | — | listener serves only the active account's store; stops on lock | — |

`SESSION_DELETED` has no subscribers today, so the cascade is wired explicitly in `session-deletion.ts` and the archive writer, not through the bus.

### 8.4 As built (P3)

Where P3 differs from §8.1–§8.3:

- **Responder.** Not a renderer coordinator or a brain handler: `crates/cognia-file-share/src/collab.rs` runs one long-poll loop per registered conversation inside the host service (desktop and headless alike), at most four requests at a time, and executes through the gateway (`Holder::Member`, principal `member:<usr_id>`, channel `collab`; admission = binding current, role rank ≥ `min_role`, listed user if `user_ids`, viewers never mutate). Writes go to a temp file then rename; reads are capped at 50 MiB, listings at 1,000 entries. A revoke cancels in-flight work through the live registry. The brain's reader-only rule is unchanged.
- **Server.** Grant ids are the host's choice, so `session_file_grants` is keyed by `(org_id, id)`. A claim is bound to the presented token (`claim_next` checks it in the same statement) and a waiting claim stops with 401 once its registration is replaced; the org's live TTL is measured from the server's clock as well as the host's `createdAt`. `crates/cognia-collab-server/src/session_files.rs` (routes under `/v1/orgs/{org}/chat-sessions/{session}/`: `file-host` GET/PUT/DELETE, `file-host/claim`, `file-host/grants/{id}` PUT/DELETE, `file-host/requests/{id}/{upload,result,complete}`, `file-grants`, `file-requests`, `file-requests/{id}`, `…/upload`, `…/result`). No `file_request.created` stream event: `claim` long-polls up to 25 s and is woken in-process. Host token `fht_` + 64 hex, header `x-cognia-file-host-token`, protocol header `x-cognia-collab-protocol: 2`. Every host call re-checks that the registrant still holds `files.share`. Limits: 32 open requests per conversation, 8 per member; JSON answers 256 KiB; transfers 50 MiB.
- **Registration.** `PUT …/file-host` (not POST), made by `lib/collab/file-host.ts` with the person's own sign-in on whichever device they share from; only the token reaches the host, through `file_collab_host_set` (`host-admin`, step-up) and `secret_store` account `collab-host:<account>:<session>`. `file_collab_host_status` (`host.observe`) reports registration, token presence, whether the loop runs, last contact, last error and unmirrored grants. Re-registration revokes the old registration's grants on both sides (`collab_host_removed`); grants record the `(org_id, collab_session_id)` they were made under and maintenance revokes any that no longer match.
- **Mirror.** `file_grants.revision` is bumped on every status change and `mirrored_revision` records what the server accepted; the host pushes the newest state until accepted. Server answers map to: 401 or bare 403 → registration ended; 403 with a reason → suspend `org_policy`; 404/410 → gone; 409 → revoke; 400/413/422 → rejected; anything else → retry.
- **One door.** `lib/filespace/live-share.ts` `createLiveFileShare` (dialog and agent tools): the collaboration plane's `files.share` check, `ensureCollabFileHost` for a members audience, then `file_grant_create`. The host refuses a members grant with no registration (`collab_host_unregistered`).
- **Member UI.** A Files section in the shared-session panel (`components/chat/shared-session-files.tsx`, shown with `files.readLive`), not a tab. The owner's view is `components/filespace/collab-host-status.tsx` in the Files panel's live-sharing section, with **Stop sharing with members**; a member holding `files.share` can **Remove sharing device** from the Files section (`DELETE …/file-host` as a member), for a lost device.
- **Agent tools.** As §8.2, plus `audience: "members"` with `min_role` on `filespace_share` (members by role only), audience in `filespace_list`, grants marked `createdBy: agent` and re-checked against `allowAgentSharing` while they live, and a result card (`filespace-share-card.tsx`) that issues passwords on the person's device.
- **Lifecycle.** `lib/filespace/lifecycle.ts`: the delete/archive writers announce changed conversations and the running host sync pushes their mount tables at once (the host derives suspend/resume/revoke from the table's session state). Deleting a conversation unregisters its file host. The delete confirmation (and emptying the archive) offers to revoke the conversation's share links.

---

## 9. Security

### 9.1 Permission intersection

```
effective = conversation role (local owner = all; collab-bound → server role via authorize_session_action)
          ∩ mount capability (dexie → read-only; offline/stale → none)
          ∩ grant (paths × permissions × audience × expiry)
          ∩ effective policy (local ∩ org, at current revision)
          − sensitive floor
```

A creator can never grant what they lack: grant creation checks the creator's own effective permission on each path (write requires write).

### 9.2 Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Path traversal / symlink escape | Normalization mirrored in TS and Rust with shared fixtures; canonicalize + prefix check; final-component symlink refusal for writes; parent-chain check for creates. |
| Cross-conversation access | Grants are bound to one `session_id`; mount tables keyed by session; agent tools bound to the calling session. |
| Mount retargeting after grant | Fingerprint check → `stale`. |
| Credential brute force | Argon2id, persisted backoff per username+IP, failed-auth-only rate charging, 160-bit random passwords, usernames carry no session info. |
| Tunnel/loopback trust | Listener never trusts loopback; `CF-Connecting-IP` honoured for audit/backoff only. |
| Secret leakage to the model | Tool results never include passwords; approval UI shows them once. |
| Revocation latency | Gateway checks on every operation; connection registry drops sessions; SFTPGo user deleted synchronously (retry queue on failure, grant stays revoked locally). |
| Org policy tightened later | Revision re-check per operation; existing grants above the new ceiling become `suspended` with reason `policy`. |
| Public snapshot of secrets | Sensitive floor excluded by default; explicit per-file user opt-in in the dialog; never by an agent. |
| Zero-knowledge regression | Blob keys derived from the fragment key; the server never sees names, paths or plaintext sizes beyond ciphertext length. |

### 9.3 Sensitive floor

One list owned by `crates/cognia-files` (`is_sensitive_workspace_file` extended: `.env*` except example/sample/template/dist, `.netrc`, `.npmrc`, `.pypirc`, `id_*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.git/` internals, `.ssh/`, `.aws/`, `.config/gh/`, `.git-credentials`, keychains), exported to TS through a generated JSON fixture consumed by `lib/filespace/sensitive.ts` and a parity test. Widening the existing walk-only floor to the other `fs_*_workspace` reads is a separate change (§13), not done here.

---

## 10. Phase plan

Each phase ships complete: code, co-located tests, en/zh-CN i18n via split sources + `pnpm i18n:build`, changeset (`minor`), docs (subsystem page under `docs/content/docs/{en,zh}/`), CLAUDE.md Subsystem Map row, `/preflight`, and the gates in WORKFLOW.md (`tsc`, `lint`, `lint:i18n`, narrow `pnpm test`, `cargo test` for touched crates, `docs:build`, `audit:colocated-tests`, `audit:rust-architecture`, network-egress, companion command manifest).

| Phase | Deliverables | Main files |
| --- | --- | --- |
| **P0** | FileSpace resolver, paths, open, links; deep link/web/CLI grammar; dock Files panel; copy-link actions. | `types/filespace/`, `lib/filespace/{resolve,paths,sources,open,links}.ts`, `hooks/filespace/`, `components/filespace/`, `lib/navigation/{cognia-deeplink,desktop-deeplink-dispatch}.ts`, `hooks/chat/use-session-link.ts`, `lib/capacitor/deeplink-router.ts`, `crates/cognia-cli/src/commands/open.rs`, `components/artifacts/{chat-dock-panels,dock-panel-meta}.ts(x)`, `components/artifacts/workspace-mode/dock-workspace.tsx`, `components/editor/project/project-file-tree.tsx`, `components/chat/message-parts/file-tool-part.tsx` |
| **P1** | Encrypted chunked blobs (server ×2 + client), files in chat shares and `file-bundle`, viewer files section, image materialization fix, branches flag fix, local + org file-sharing policy, collab `FilesShare`. | `services/share-server/{src,core,worker,share-constants.json,tests}`, `lib/share/{types,blobs,file-selection,client,chat-export,load}.ts`, `components/share/*`, `components/data/export/single-export-dialog.tsx`, `lib/filespace/policy.ts`, `lib/collab/file-sharing-policy.ts`, `crates/cognia-collab-server/{migrations/0014_file_sharing.sql,src/*}`, `lib/collab/session-permissions.ts` |
| **P2** | `cognia-file-share` crate (store, gateway, credentials, backoff, audit, builtin WebDAV + SFTP, SFTPGo provider, listener, maintenance), host sync + grants client, live share UI, settings card, companion RPC, headless wiring, compose file, ADR-0162 amendment. | `crates/cognia-file-share/`, `src-tauri/src/lib.rs` (registration), `src-tauri/src/bin/cognia-server.rs`, `src-tauri/src/process_registry/mod.rs`, `lib/filespace/{host-sync,grants-client}.ts`, `components/filespace/live-share-*`, `components/settings/connectivity/blocks/network-drive-block.tsx`, `deploy/compose/compose.sftpgo.yaml`, `scripts/gates/*` |
| **P3** | Collab host registration, grant mirror, request channel, host responder (host crate, desktop + headless), member Files section and owner view; agent tool family; lifecycle cascade (delete/archive/rebind) across shares and grants; audit viewer. | As built: `crates/cognia-collab-server/{migrations/0015_session_files.sql,src/session_files.rs}`, `crates/cognia-file-share/src/collab.rs`, `lib/collab/{file-requests,file-host}.ts`, `lib/filespace/{live-share,lifecycle,agent-tool-deps}.ts`, `components/chat/{shared-session-panel,shared-session-files}.tsx`, `components/filespace/collab-host-status.tsx`, `lib/claude/{filespace-builtin-tools.ts,plugin-tool-ipc.ts,build-options.ts}`, `lib/claude/permissions/filespace-tool-rules.ts`, `lib/policy/risk/classify-risk.ts`, `lib/chat/{session-deletion,session-archive-writes}.ts` |

---

## 11. Rejected alternatives

- **A `conversationFileSpaces` Dexie table.** Duplicates execution bindings; would drift on move/rebind/sync. The fingerprint gives live grants the stability a table would have offered, without a second authority.
- **Turning share links into a live file API.** Breaks ADR-0037's blind-server property and its non-goal of real-time shares.
- **SFTPGo as the only provider.** Cannot see desktop files; AGPL bundling; a second account system to keep in sync for the common case.
- **Mounting WebDAV inside the companion router.** 64 KiB body cap, drain semantics, loopback trust and tunnel exposure are all wrong for a credential-authenticated file protocol.
- **Reusing `ssh.files` / Control device grants.** Those mean "the whole machine" (ADR-0162) or "everything a paired device may do"; a share credential must mean "these paths of this conversation".
- **Reusing collab attachments as-is for live reads.** Session-wide visibility and persistence; requester-only ephemeral objects are needed.

## 12. Spikes to run at the start of P2

1. `dav-server` 0.11 under axum 0.8 with a custom filesystem: streamed multi-GB PUT/GET, LOCK with Finder.
2. Finder and Windows WebClient against: loopback HTTP, LAN HTTPS with the companion's self-signed certificate, a cloudflared named tunnel. Record which modes each client accepts; the UI offers only working combinations per platform.
3. `russh` 0.63 server + `russh-sftp` 3.0 handler with OpenSSH `sftp`, rclone, Cyberduck, WinSCP.
4. SFTPGo 2.x REST: user + virtual folder + `denied_patterns` + `expiration_date` round trip in compose.

## 13. Out of scope (tracked separately)

- **P4 (proposal):** serving a remote sandbox's live tree (ADR-0221 Kubernetes/E2B) through the exec channel, multi-node hosts and cross-agent file sharing. The gateway's mount `backing` gains a `remote` kind then; the `remote-sandbox` status reason and its live-grant refusal arrive with the per-session placement ADR-0221 has to expose first.

- Tunnelled requests satisfying `require_loopback_operator` on the companion router.
- Mobile `cognia://session/<id>` routes to the IM inbox (`/inbox/c?key=`) and likely shows "unavailable" for non-IM sessions.
- Share viewer has no `workflow-result` case; "Never expires" is 30 days server-side; a passphrase share spends its view before the passphrase is entered.
- Sensitive floor only on `fs_walk_workspace`; local `fs_*` confinement in shadow mode; no persistent `SecureFileSystem` audit.
