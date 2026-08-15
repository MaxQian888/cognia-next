---
title: "0124 — Filesystem Viewer Registry"
description: "Unifies three file-preview implementations behind one host-owned registry, and confines every read to the open workspace roots."
---

# ADR 0124 — Filesystem Viewer Registry

**Status:** Accepted
**Date:** 2026-08-15

## Context

The app had three answers to "show me this file", and the one users reached
most often was the least safe.

The terminal's read-only dialog called `lib/file/file-operations.readTextFile`
with a bare absolute path: no root, no traversal check, no size limit, and only
a Monaco renderer. The project workbench's preview dispatched on file extension
over the in-memory editor draft, using the most permissive iframe sandbox in
the repository. The task-resources panel dispatched on media type and was the
only one with hardening or a size cap — and it does not read the filesystem at
all, so it is not part of this unification.

Five call sites reached the terminal store's `openFile(absolutePath, …)`, not
the two the work started from: terminal links, chat file links, the two stack
trace views, and the log detail panel.

## Decision

### The host owns every read

A contribution is handed text that has already been confined to a workspace
root and size-checked. It never receives a path it could resolve — `matches`
takes a probe of extension, size and source, and the renderer takes text.

This is the invariant the registry exists to keep. A viewer that can see a path
is one refactor away from reading it, at which point the confinement below
means nothing.

### Contributions load lazily

`FileViewerContribution.load()` is a module loader, not a component reference.
`isProjectFilePreviewable` consults this registry from
`lib/context-workbench/capabilities.ts`, which the artifact dock, the canvas
side panels, the workflow sidebar and the project workbench all import. An
eager component would drag Monaco, `MarkdownRenderer` and DOMPurify into every
one of those bundles to answer a question about a file extension.

Built-ins are seeded at module init rather than on first render, so the answer
does not depend on whether a component has mounted.

### The text fallback is scoped by source, not by file kind

`builtin.text` matches `source === "terminal"`. That keeps
`isProjectFilePreviewable` answering exactly what its hard-coded list answered
— nothing claims a `.py`, so no Preview tab appears where none did before — and
avoids mounting a read-only Monaco of `draftContent` beside the editable Monaco
already showing the same buffer.

Resolution is priority descending, ties by id. Deliberately unlike
`lib/artifacts/renderer-registry.ts`, which declares a `priority` it never reads
and lets the last registration for a kind silently win.

### Roots come from the open projects, not from `cwd`

The rejected alternative was the terminal session's working directory. It is
not a boundary: the shell rewrites it on every `cd`
(`spawn-orchestrator` calls `setSessionCwd` on each `cwd_changed`), so `cd /`
widens the confinement to the whole filesystem and `cd src` narrows it enough
to break links to sibling files that worked a moment earlier. A boundary that
moves when the user types is not one.

This is recorded because the failure it prevents is invisible: someone looking
at an "outside workspace" error will reach for `cwd` as the obvious fix.

Instead the root set is the union of every open project's roots — the same set
`lib/files/allowed-roots-sync.ts` pushes into the Rust allowed-roots registry,
so the renderer's boundary and the backend's agree, and a stack frame pointing
into a sibling checkout the user also has open still resolves. Deepest root
wins; a caller that knows its own workspace passes it as `preferredRoots` to
break a tie.

`openFile(absolutePath, …)` was deleted rather than deprecated. That signature
*was* the unconfined API; removing it is what makes the confinement
unbypassable instead of merely encouraged.

### Size is capped by the host, at 2 MiB

`fs_read_workspace_file` deliberately has no default cap, and truncates with an
appended marker rather than failing — pinned by
`read_workspace_file_never_silently_truncates_an_editor_read`. A viewer that
leaned on that would show a file silently missing its tail.

So the surface stats first and refuses before transferring, then reads with
`MAX + 1` bytes: a file that grew between the stat and the read comes back
over the limit and is rejected, rather than arriving quietly shortened.

### Failures open the dialog

A refusal opens on the error rather than doing nothing. A click that silently
fails is indistinguishable from a broken link — which is precisely how chat
file links behaved whenever the terminal panel was closed, because the dialog
was mounted inside `TerminalDock`. It now mounts at the app shell.

### HTML sandboxing splits by source

Both sources get a CSP with `connect-src 'none'`, and neither ever gets
`allow-same-origin`. The old project preview granted `allow-scripts` with no
policy at all, so a previewed file could fetch its own contents to any origin;
an opaque origin stops a frame reading the host, not talking to the network.

Scripts stay enabled for `project-preview` — that markup is the user's own
draft, and disabling them would quietly break every existing preview. They are
disabled for `terminal`, where the file is far more likely to be tool-generated
or downloaded than authored, and the body is sanitised as well.
`allow-forms`, `allow-modals` and `allow-popups` are gone from both.

### Diagnostics carry no identity

`fileViewer.render` and `fileViewer.error` log source, extension, size band,
duration and (on failure) a code. Never a path, a filename or content: an
extension is safe to record, a name is not, and an exact byte count is a weak
content fingerprint. The payload's key set is pinned by a test, which is the
only durable defence against someone adding `path` later for debugging.

## Consequences

- A terminal or chat link to a path outside every open workspace now refuses
  instead of opening. Stack frames into `/usr/lib/...` are the common case.
  If the refusal rate proves too high, the answer is to widen the root set, not
  to disable the check — the logs carry source and code and no path, so the
  rate is measurable without recording what was refused.
- The dialog is still unmounted on mobile, where the desktop shell bypasses its
  chrome, so chat file links remain a no-op there. That follow-up is not in
  this change.
- No plugin-facing viewer API yet. The contract should hold through a minor
  release before it freezes under one.
