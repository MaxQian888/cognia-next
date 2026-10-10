---
title: "0223 — Files is a space you manage"
description: "The Files page becomes a managed space: a sidebar of places (all, type groups, recents, a folder tree, Trash) crossed with lenses (Suggested, Favorites, Mine, AI-generated, Shared with me), a table with source and activity columns, bulk and drag-and-drop management, rename and duplicate, a Trash that keeps bytes for 30 days, a document template domain, agent-written workspace files, and the same library on the phone through the host."
---

# ADR 0223 — Files is a space you manage

**Status:** Accepted. Implemented: §1–§7, §10, and §9 for a standalone phone. Pending: §8 (workspace files) and §9 for a paired phone, which both need host-side Rust work; until they ship, the Workspace files group is absent and a paired phone has no Files page.
**Date:** 2026-10-10
**Related:** [ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep) (Files, partly superseded),
[ADR-0222](./0222-a-conversations-files-are-a-view-and-sharing-them-is-a-grant) (FileSpace and file sharing),
[ADR-0100](./0100-unified-template-platform) (templates),
[ADR-0149](./0149-a-person-is-not-a-device) (collaboration),
[ADR-0027](./0027-mobile-offline-and-discovery) (the phone as a client)

## Context

ADR-0200 made Files a view over content that lives elsewhere and let you keep
what you want. In use it was a gallery, not a place you work in:

- five header tabs mixed *where* to look (images, folders) with *how* to look
  (recent, favorites), so neither could be combined with the other;
- "Remove from Files" hid an item until its source next changed, with no way to
  see or undo it, while a Files-owned upload was deleted outright;
- everything was one item at a time: no selection, no drag and drop, no rename,
  no duplicate, no export of more than one file;
- the list view had no columns, so where an item came from and when it was last
  touched were invisible;
- the template platform declared a `document` domain with no store behind it;
- files an agent wrote to disk, and the phone, were both out of scope.

## Decision

### 1. Places × lenses

The page gets a secondary sidebar of **places** — All, type groups (documents,
artifacts, images, videos, uploads, workspace files), Recents, a nested folder
tree, Trash — and a row of **lenses** over the main area — Suggested, Favorites,
Mine, AI-generated, Shared with me. Any place combines with any lens; the Trash
ignores lenses. The list view is a table: name, source (the conversation,
"Upload", or "—" once it is gone), last activity, size, type; a header sorts.
ADR-0200's `?tab=` links redirect to the matching place or lens.

### 2. The Trash keeps bytes for 30 days

`libraryItems.trashedAt` (indexed, Dexie v237). Moving to the Trash replaces
both "Remove from Files" and "Delete":

- a trashed item never comes back on its own when its source changes;
- it keeps its favorite and folder, so a restore puts it back where it was;
- it counts as kept, so its bytes stay pinned and a conversation's purge spares
  it — a restore within the window always finds them;
- restoring an item nothing outside Files holds any more files it at the root
  of Folders, where it stays kept.

"Delete forever" and the 30-day purge (a scheduler maintenance task,
`files-trash-purge`, skipped on a paired client) end an item by one rule:

| Item | Ends as |
| --- | --- |
| Files-owned (uploaded straight into Files) | deleted, bytes included unless a conversation still references them |
| Source still alive (its conversation exists; a canvas document made outside any conversation counts as alive) | "removed from Files" (`hiddenAt`); the source is untouched |
| Source gone (only Files kept it) | row and pin dropped, so media GC takes unreferenced bytes; an orphaned artifact or canvas row is deleted |

Files never deletes another surface's live content.

### 3. Who made it, and who shared it

- **Mine vs AI-generated** is the creator. Canvas documents record
  `createdBy` (`user` from menus and editors, `agent` from the canvas tool and
  plugins); older documents read as the person's when made outside a
  conversation or from an editor. Artifacts are cut from conversation output, so
  they read as AI-made unless standalone or derived from the person's own canvas.
  An image reads as the role of the message that shows it; an upload is the
  person's unless it is a generated video.
- **Shared with me** is an item whose conversation is a joined collaboration
  projection (`shared:` id). A session the account itself converted to shared
  keeps its own id and stays "mine".

### 4. Suggested is a local score

`exp(-age/14d) + 0.35·log2(1+conversations) + 0.5·favorite + 0.25·opened this
week`. No model call. A header sort overrides it.

### 5. Rename and duplicate respect ownership

- Rename: a canvas document and a Files-owned upload are renamed at the source
  (the download is called that); every other kind stores `displayName` on its
  item, and the source keeps its title. ⌘K lists items under their Files name
  and leaves out what is removed or trashed.
- Duplicate: a canvas document or artifact becomes a new canvas document; an
  image, attachment or workspace file becomes a Files-owned upload (bytes are
  deduplicated by content hash). The copy is the person's.

### 6. Document templates are a store

`documentTemplates` (Dexie v237) holds templates the person saved from a canvas
document or Files; five built-in templates (guide, to-do list, project tracker,
weekly update, meeting notes) are code, localized. The template platform's
`document` domain projects both, so its dormancy ends. Files shows them as a
collapsible strip on Suggested and under New; picking one creates a canvas
document. All of it is hidden when the template platform is off.

### 7. Management

Range selection with bulk favorite, move, Trash and zip export (folder paths
kept); drag items onto a folder or the Trash, drag a folder to re-parent it
(no cycles), drop files from the system to upload; a context menu that is the
item menu; keyboard shortcuts on the list (select all, Trash, rename, move,
clear). Folders carry a color and an icon from fixed sets.

### 8. Workspace files

Files an agent created, modified or renamed are a kind of their own, listed from
the task-workspace ledger with code-adoption turns filling the gaps, one entry
per conversation and path. Paths and mount status come from the conversation's
FileSpace (ADR-0222); opening one uses its `view=files` link; existence is
checked on open. Files never writes to or deletes them on disk: rename is a
display name, Trash is Files' own, duplicate copies into a Files upload. Without
a filesystem backend (plain web) the kind is dormant and says so.

### 9. The phone

A standalone phone runs Files over its own data. A paired phone reads and
writes the host's library through `files_library_*` host commands and fetches
bytes on demand as a `library-media` resource; the surface contract moves from
`companion: hidden` to `companion: remote`. The phone layout is a list with
long-press selection and drawers, without drag and drop or shortcuts.

On a paired phone:

- the commands use the device capabilities `client.read` and `client.write`, as
  remote pet care does (ADR-0219): a member device reads, an owner device
  writes, and an admin can raise a member;
- opening a canvas document or an artifact previews it read-only — text and
  images through `library-media`, up to its 10 MiB cap, past which the preview
  says to open it on the desktop — and an item from a conversation can jump to
  that conversation on the phone;
- Share is dormant and says to share from the desktop: the share policy, the
  collaboration checks and the link records all live on the host, and
  uploading a large selection would outlast the 30-second host bridge.

### 10. Sharing rides ADR-0222

Sharing uses ADR-0222's file snapshot: a `file-bundle` share link whose files
travel as client-encrypted, chunked blobs. "Share…" on one item, or on a
selection from the bulk bar, publishes one link through the same share dialog
and the same `createFileShare` gate as a conversation's files, so the
file-sharing policy, the sensitive-file opt-in and the server's size limits
apply unchanged.

- Each file is named in the bundle by its place in Files,
  `/files/<folder path>/<name>`, numbered like a zip export on a clash.
- Items come from many conversations, so before anything is uploaded — in the
  dialog's `buildPayload`, ahead of the gate, which is handed no conversation —
  every collaboration conversation an item belongs to is asked for
  `files.share`. One refusal refuses the whole link, and so does a shared
  conversation an item names that is no longer stored on this device, since it
  cannot be asked. The newest org policy revision any answer named is loaded
  before the gate reads the policy. The link is recorded without a `sessionId`.
- The link's code is recorded on the items it carried
  (`libraryItems.sharedLinkCodes`). An item shows a "shared by link" marker
  while one of those codes is live in `sharedLinks` (not revoked, not
  expired). The link itself, its key and its owner token stay in
  `sharedLinks` on the device that made it.
- A trashed item cannot be shared.

## Consequences

- One rule for what removing, restoring and purging mean, shared by the page,
  ⌘K and the purge task.
- Trashed bytes count against the asset quota for up to 30 days.
- The phone gains a host-command family and a binary resource; a paired client
  never mirrors the Files tables.

## Rejected

- **Keeping `hiddenAt` as the Trash.** An item that revives when its source
  changes cannot be a Trash: things would leave it on their own.
- **Deleting a trashed artifact or canvas document whose conversation is alive.**
  Files is a view; another surface's live content is not Files' to delete.
- **A purge swept only when Files opens.** Bytes would stay pinned for as long as
  the person stays away from Files.
- **A new share kind for files.** ADR-0222 already extends share links to carry
  files; a second path would duplicate its limits and its crypto.
