---
title: "0200 — Files is a view that keeps what you keep"
description: "Artifacts, canvas documents, chat images and uploaded files used four stores. Each was visible only from its conversation and was deleted with that conversation. Adds /files as an aggregated view of the existing stores. Favorites and folders preserve item bytes after session deletion. Supports uploads without a conversation, ⌘K and @canvas references, and portable backup."
---

# ADR 0200 — Files is a view that keeps what you keep

**Status:** Accepted
**Date:** 2026-09-27
**Related:** [ADR-0158](./0158-artifacts-and-canvas) (artifacts are Dexie-authoritative), [ADR-0129](./0129-unified-global-search) (⌘K and its Library scope), [ADR-0157](./0157-references-and-result-reuse) (entity mentions), [ADR-0001](./0001-backup-schema-v3) (portable backup)

## Context

What a conversation produces is spread across four stores:

| Content | Store | Visible from |
| --- | --- | --- |
| Artifacts | `artifacts` (Dexie-authoritative) | that conversation's artifact panel, or "recent" |
| Canvas documents | `canvasDocuments` | the Canvas guild |
| Images (uploaded or generated) | `messageMedia` + `messageMediaRefs` | the message that shows them |
| Uploaded files | session assets (`messageMediaRefs` rows with `sessionAsset`) | that conversation only |

Nothing lists them together, nothing searches them by body across
conversations, and deleting a conversation deletes all of it: `bulkDeleteSessions`
drops the media references and `clearSessionData` drops the artifacts and
canvas documents. A design spec someone wanted to keep went with the chat it
was attached to.

## Decision

### An aggregated view, not a copy

`/files` reads the existing stores and merges them into one card list
(`lib/files-library/aggregate.ts`). The content stays where it lives. Files
adds only what the view needs, in two new tables (Dexie v231):

- `libraryItems` — one row per item the user touched from Files, keyed
  `kind:sourceId`: favorite, folder membership, "last opened from Files",
  "removed from Files", ownership of Files uploads, and a snapshot (title,
  media type, size, extracted text) so a kept item still has a name after its
  source row is gone.
- `libraryFolders` — the folder tree, the same shape as `workflowFolders`.

Folding rules use one image card per canonical hash ("in N conversations")
and one file card per upload content hash. An image upload uses its image card.
A conversation upload whose bytes were also uploaded to Files uses the
Files card.

### Keeping is a reference, not a copy

An item is **kept** when it is a favorite, is in a folder (the root counts),
or was uploaded to Files. A kept item whose bytes live in `messageMedia` holds
one ref row under the reserved owner `library:<key>` with the sentinel session
id `library:files`. Session ids never contain `:`, so:

- session deletion, the project cascade and sync tombstones (all by session
  id) never touch it;
- media GC (by hash) sees the bytes as referenced;
- `[sessionId+hash]` authorization never matches it, so a pin grants no
  conversation access.

`libraryItems` is authoritative and the pins are derived: every keep-state
write updates both in one transaction, and `reconcileLibraryPins` rebuilds
the pins after a restore. Artifacts and canvas documents need no pin: the
session purge asks `listKeptSourceIdsForSession` and `clearSessionData`
spares those ids, keeping their `sessionId` (the UI reports "conversation
deleted").

"Remove from Files" on a conversation item drops the favorite and folder and
hides it until its source changes again; the source is untouched. Deleting is
only for Files-owned uploads, and deletes their bytes unless a conversation
that used them still references them. Deleting a workspace with its data
deletes its Files items. "Clear conversations" leaves `library:` rows alone.

### Uploads that belong to no conversation

"New → Upload" stores a raster image through the chat `ingestImage` path and
anything else as a Files-owned original (`putLibraryAsset`) under
`library:upload:<assetId>`, counted in the same global asset quota. Text is
extracted at upload with the composer's own `extractAttachment` (up to
50 MiB), so the page and ⌘K can search the body.

### Using a file in a chat reuses the existing paths

- Artifacts and canvas documents become the same context chip the `@` panel
  stages. Canvas gained its own mention source, `@canvas:`.
- Images and files are appended to the target conversation's draft as
  restored-draft attachments; storage dedups on send. A source larger than the
  150 MiB draft quota is bound to the conversation as a session asset instead
  (`bindHeldSessionAsset`), with no bytes copied.

The target is the active conversation when it accepts a message, otherwise a
new one.

While wiring this, restored draft attachments turned out to be corrupted in
every encrypted account database: the content cipher `JSON.stringify`-ed the
payload, so `bytes: Uint8Array` came back as `{"0":…}` and a revived file held
`[object Object]`. The cipher now carries byte arrays under a tagged base64url
encoding and revives them on decrypt; older rows parse as before.

### Where Files runs

Desktop and web. The contract is `standalone: "full"`, `companion: "hidden"`
(nothing Files lists reaches a companion, so a paired client's local copy is
not the host's library) and `offline: "local"`. The phone shell is deliberately
dormant, labelled on all three axes as `filesRequiresDesktopOrWeb`: the rail
entry is `mobileHidden`, the ⌘K providers return nothing on the phone, and a
deep link renders an explanation.

### Search and backup

⌘K gains three kinds in its Library scope — `artifact`, `canvas-document`
(both referenceable) and `library-file` — filtered by workspace, opening the
item's preview at `/files?item=`. Search there is by name; Files itself
searches bodies. The existing ⌘K "Library" scope keeps its name, which is why
the page is called Files.

The portable backup carries `libraryItems`, `libraryFolders` and Files-owned
upload metadata, and sends every byte Files keeps or owns through the existing
media section in one pass with the transcripts' media. A backup restored
without its conversations still restores what Files kept.

## Consequences

- Kept content can now outlive its conversation. Storage used by kept images
  and files counts toward the session asset quota (uploads) and the storage
  view like any other media.
- `messageMediaRefs` has a third owner kind besides messages and session
  assets. Every consumer that filters by session id is unaffected; consumers
  that scan the table must use `isMessageOwnedMediaRef` / `isLibraryMediaRef`.
- Agent-written files on disk and knowledge-base documents are not in Files
  yet; they live in the task-workspace ledger and the RAG subsystem.
