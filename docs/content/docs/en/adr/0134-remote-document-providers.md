---
title: "0134 — Remote Document Providers"
description: "Reference Feishu and Google Workspace documents from the chat composer without inventing a second attachment pipeline or polluting the IM connector contract."
---

# ADR 0134 — Remote Document Providers

**Status:** Accepted
**Date:** 2026-08-19

## Context

The composer's `@` could only reference local workspace files. `searchWorkspace`
walks a Tauri root, the pick writes `@relPath` into the text and an absolute
path into `chatStore.referencedPaths`, and `resolveSendOptions` announces the
parent directory so the agent's Read tool can fetch it on demand. Every step of
that assumes the referenced thing has a path.

Most of the documents users actually cite do not. They live in Feishu 云文档 and
Google Workspace, and the only way to bring one into a conversation was to open
it, select all, and paste.

Two of the four pieces already existed and were not reachable from chat:
`lib/twin/ingest/lark-doc-fetcher.ts` reads Feishu docx / wiki / legacy docs
through the connector's credentials for the Digital Twin, and
`lib/skills/built-in/lark/` exposes 40 lark-cli-backed skills. Google had
nothing: `ALL_PLATFORM_KINDS` does not even reserve the name, and the one Google
OAuth in the repo belongs to the Drive *backup* destination.

## Decision

### A sibling subsystem, not an extension of Platform Connectors

`PlatformAdapter` is confined to IM conversation semantics by ADR-0009 — `send`,
`edit`, reactions, chat management, an A2UI matrix. Adding `searchDocuments()`
to it would force Google to be modelled as a connector with no messaging, whose
`send` and `health` are empty stubs. So `lib/docs-providers/` is a peer
registry: module-level map, duplicate id and duplicate mention-prefix both
throw, built-ins registered at module load in `./index`.

The Feishu provider still *uses* a connector instance's credentials, because
that is where the user's Feishu account already lives. Borrowing beats a second
connection the user would have to authorize and revoke separately.

### Fetch on pick, deliver as an attachment

A picked document is fetched immediately and staged as a synthesized `File`,
which rejoins the ordinary attachment pipeline (`prepareComposerAttachments` →
`staged-attachment-store` → `lib/chat/attachments/dispatch.ts`).

This is the decision that keeps the feature small. The redaction gate, the token
count on the chip, the `INLINE_TOKEN_CEILING` over-length confirmation, the
"model view" preview and draft restoration are all inherited rather than
rebuilt. The alternative — a reference the agent resolves later — would need a
per-provider tool, and Feishu's only tool path depends on the user having
installed `lark-cli`.

The body is wrapped with `wrapUntrustedContent` first: a third-party document is
external data, not instructions.

### Truncation is always visible

A Bitable app can hold hundreds of thousands of records. Every cap in
`limits.ts` sets `RemoteDocContent.truncated` **and** appends a marker into the
body. Silence would be worse than refusal — the model would answer confidently
from a document missing its tail.

For the same reason Google Sheets is read through `spreadsheets.values.batchGet`
rather than Drive's CSV export, which silently returns only the first worksheet.

Hidden worksheets are skipped on both providers: they are hidden from the user,
so feeding them to a model would show more than opening the link does.

### Google needs a loopback redirect, and that is why the feature is desktop-only

Google restricts its device-code flow to a fixed scope list — `email`, `openid`,
`profile`, `drive.appdata`, `drive.file` and the YouTube scopes. None of the
read scopes this feature needs is on it, so the flow the Drive backup
destination uses physically cannot read a document the user already owns.

That leaves the installed-app flow, whose only permitted redirect for a Desktop
client is a loopback address. The connectors axum server is the app's only
loopback HTTP host, so it gains `/oauth/docs/{provider}/callback`, bouncing to
`cognia://docs-provider/oauth/<provider>` exactly as the Lark relay does.
`connectors_ensure_server` was added beside `connectors_start_server` rather
than relaxing it: the existing command errors when a server is already running
because it is the boot path, and a second boot is a lifecycle bug. The OAuth
flow wants the address, not the transition.

Feishu is desktop-only for a different concrete reason: `open.feishu.cn` sends
no CORS headers, so only the Rust `connectors_http_request` bridge can reach it.

Both reasons are physical, not policy. `DocsProvider.hosts` records them, the
picker and the settings card render a localized explanation elsewhere, and a
test pins that the registry yields nothing on web, mobile or headless.

### The Google document connection is separate from the Google backup connection

Sharing the keyring key would couple them: reconnecting one would break the
other's identity, and widening the backup connection's `drive.file` scope would
hand a write-only-to-its-own-folder integration a read of the user's entire
Drive. They are separate connections under the `docs-providers` namespace and
may be different Google accounts.

### Feishu search requires the user identity

`POST /open-apis/suite/docs-api/search/object` accepts only a
`user_access_token`. The shared harness normally falls back to the tenant (bot)
token, which here produces a misleading permission error, so
`withLarkAuthedApi` grew `requireUserIdentity` and search fails fast with
`notAuthorized` instead.

A provider without search is not an error: the panel offers link-pasting, which
is a complete answer for a user who has the link.

### One authenticated-Lark harness

`lark-doc-fetcher.ts` owned the only "resolve the best Lark identity, refresh
silently, fall back to the bot" implementation. Rather than copy it for
spreadsheets and Bitable, it was extracted to
`lib/connectors/adapters/lark/authed-api.ts` and the fetcher rewritten onto it;
its existing 41 tests pin that the behavior did not move.

## Consequences

- No Dexie version. Credentials live in the keyring, fetched bodies are
  ephemeral attachments.
- `@lark:` covers docs, wiki nodes, spreadsheets and Bitable; `@gdoc:` covers
  Docs and Sheets. Slides and mindnotes are excluded because neither platform
  offers a useful text read, so the picker never offers something that fails at
  fetch time.
- `parseLarkDocUrl` keeps rejecting sheets and Bitable; the wider
  `parseLarkResourceUrl` is what the provider uses, so the twin pipeline is
  byte-identically unchanged.
