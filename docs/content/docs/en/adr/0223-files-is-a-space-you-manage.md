---
title: "0223 — Files is a space you manage"
description: "The Files page becomes a managed space: a sidebar of places (all, type groups, recents, a folder tree, Trash) crossed with lenses (Suggested, Favorites, Mine, AI-generated, Shared with me), a table with source and activity columns, bulk and drag-and-drop management, rename and duplicate, a Trash that keeps bytes for 30 days, a document template domain, agent-written workspace files, and the same library on the phone through the host."
---

# ADR 0223 — Files is a space you manage

**Status:** Accepted. Implemented: §1–§10.
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

Files an agent created, modified or renamed in a conversation's workspace are a
kind of their own, `workspace-file`, one entry per conversation, workspace root
and path. A renamed file keeps the id of the path it was first listed under, so
a favorite or a folder follows it through the agent's renames.

- **Where the list comes from.** The task-workspace ledger answers
  `task_workspace_list_resource_index`: its settled resource changes, joined to
  the conversation that owns each task and folded in the order they settled.
  Only an agent's change adds a path; a delete or a rename, by anyone, removes
  or moves it; a change the ledger marks sensitive, generated or a symlink
  removes it; a file that was created stays "created" through later edits. A
  conversation the ledger holds nothing for (an external agent that never ran
  through it) is filled from its code-adoption turns instead, skipping rejected
  or reverted turns and files and the same credential-shaped paths
  (`.env`, private keys and the like). A conversation the ledger does hold is never patched
  from turn rows.
- **Where it shows.** Under the sidebar's Workspace files group, and elsewhere
  only once the person has touched it: in its folder once filed, under All's
  Favorites lens once favorited, and in Recents once opened, favorited or
  filed. All under any other lens never lists them, so an agent's busy run
  does not bury what the person made. ⌘K leaves them out.
- **Where the bytes are.** A path is relative to the run's execution root. An
  isolated run's root can vanish once its changes are applied back, so a read
  tries the execution root, then the workspace root, and a file found in
  neither is gone ("This file is no longer on disk."). Existence is checked on
  open, not when listing.
- **Open** goes to the conversation and opens the file in its Files panel
  through ADR-0222's opener when the conversation's FileSpace contains it; a
  file outside it (a run root the FileSpace no longer mounts) is previewed in
  place, read-only. Download, duplicate and Use in chat read the bytes where
  they are now.
- **Files never touches the disk copy.** Rename is a display name, Trash is
  Files' own state, duplicate copies into a Files-owned upload, and a purge
  forgets the item. A kept workspace file stores where it was, so it stays
  listed after the ledger prunes its run.
- **Paired phone.** The host lists its own workspace files in the library the
  phone reads. Their bytes are not session media, so the phone reads them with
  `files_library_read_chunk`: up to 512 KiB a call, at most 10 MiB a file,
  named by the item's key only, so the device never names a path and the host
  reads only a file its own listing holds. A file that changes size mid-read
  restarts once.
- **Dormant without a filesystem backend.** On plain web there is no ledger
  and no disk to read. The capability `workspaceFiles` carries the reason
  (`no-fs-backend`, use the desktop), the group stays in the sidebar disabled
  with a hint, its empty state says why, and a test pins all three.

### 9. The phone

A standalone phone runs Files over its own data. A paired phone manages the
host's library: the page mounts a different backend, and the layouts do not
branch on which one they draw. The phone layout is a list with long-press
selection and drawers, without drag and drop or shortcuts.

On a paired phone:

- **The library is the host's, live.** Every read and write is one of 23
  `files_library_*` host commands, bridged to the desktop renderer and run by
  the same writers the desktop page uses. The host rebuilds its own aggregate
  for every call and acts on the entries it finds there, so a phone can neither
  claim an item is Files-owned nor reach a source its library never listed. The
  list and the folders are read in pages; a list page carries the revision of
  the list it was cut from, and a phone whose pages disagree starts over. The
  surface contract moves from `companion: hidden` to `companion: remote` on
  `files_library_list`, behind the host feature `files.library-remote`, which
  only the desktop advertises (a headless brain answers every arm
  `headless_host`).
- **Nothing is mirrored and nothing is queued.** The phone re-reads after each
  of its own changes, when the page becomes visible or regains focus, every
  30 seconds while it stays visible, and on pull to refresh or Retry. A failed
  read keeps what was shown and says why. With the host offline the page is
  blocked: a move or a Trash replayed later would act on a library that has
  moved on.
- **Search** matches titles on the phone and asks the host which items match
  inside their bodies (`files_library_search`), since the entries carry no
  excerpts. ⌘K on a paired phone lists the host's items by title.
- **Capabilities** are `client.read` and `client.write`, as remote pet care
  does (ADR-0219): a member device reads, an owner device writes, and an admin
  can raise a member. Duplicate, Use in chat, New folder and an upload's commit
  carry a body `idempotencyKey` that the host folds retries onto, per device.
- **Bytes** travel over the existing `session-media` binary resource, not a new
  one: an item Files keeps is read under the library's sentinel session
  (`library:files`), which the host authorizes by the library's own pin, and
  anything else through a conversation that shows it. A held original
  (`original:<sha>`) answers the original variant. The 10 MiB cap is the
  resource's own; past it, the preview, a download and a zip say to use the
  desktop, by name.
- **Open** previews read-only — an artifact's or canvas document's text from
  `files_library_get`, images and files from those bytes — and an item from a
  conversation leads to that conversation instead.
- **Use in chat** binds an image or file to the conversation on the host,
  without copying bytes. An artifact or canvas document becomes a reference
  chip in the phone's own composer, from the text the host returns.
- **Upload** stages each file of at most 10 MiB on the attachment staging
  channel, under the library's sentinel session and the device that began it,
  then files it in the library at commit. Any type is accepted; the commit's
  magic-byte inspection still runs.
- **Held back, and labelled**: creating documents — a new canvas document, one
  from a template, Save as template, the template strip — because the phone
  cannot edit the host's canvas, and Share, because the share policy, the
  collaboration checks and the link records all live on the host, and uploading
  a large selection would outlast the 30-second host bridge. Each stays listed,
  disabled, saying to use the desktop.

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
- The phone gains a host-command family; its bytes ride the existing session
  media resource. A paired client never mirrors the Files tables.

## Rejected

- **Keeping `hiddenAt` as the Trash.** An item that revives when its source
  changes cannot be a Trash: things would leave it on their own.
- **Deleting a trashed artifact or canvas document whose conversation is alive.**
  Files is a view; another surface's live content is not Files' to delete.
- **A purge swept only when Files opens.** Bytes would stay pinned for as long as
  the person stays away from Files.
- **A new share kind for files.** ADR-0222 already extends share links to carry
  files; a second path would duplicate its limits and its crypto.
