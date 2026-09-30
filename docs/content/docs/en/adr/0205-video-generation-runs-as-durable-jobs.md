---
title: "0205 — Video generation runs as durable jobs"
description: "Video generation becomes a first-class feature: one engine starts a provider job with the AI SDK's startVideo, persists the opaque operation in a Dexie job row, and a renderer reconciler polls it across reloads, downloads the result once and stores it where it was requested. The chat tool, /video, the Files page, a workflow node, the plugin API and the executor's videos.* handlers are all adapters over that engine."
---

# ADR 0205 — Video generation runs as durable jobs

**Status:** Accepted
**Date:** 2026-09-29
**Related:** [ADR-0168](./0168-an-edit-is-a-new-version-of-the-same-message) (one media engine, plugin API delegates), [ADR-0180](./0180-a-video-reaches-the-model-as-what-it-can-read) (video input handling), [ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep) (files aggregate), [ADR-0163](./0163-provider-operation-contract) (provider-operations executor)

## Context

Cognia could generate video but no user could reach it. `generateProviderVideo`
and the provider-operations executor's `videos.*` handlers were called only by
the plugin API and the CLI. Three facts made the existing path unusable as a
product feature:

- **It was synchronous.** `experimental_generateVideo` polls inside the SDK
  for up to ten minutes. A renderer tool call times out after 120 s, and a
  reload lost the job and whatever it had cost.
- **It could not run in the packaged desktop app.** The video models were
  built without an injected `fetch`, so every request hit the WebView's
  `connect-src` CSP. `pnpm dev` has no CSP, which hid this.
- **Job handles did not survive a reload.** The executor's job registry is an
  in-memory map; after a reload `videos.get` on a local handle fell through to
  the Veo wire with an id Veo had never issued.

The installed AI SDK already had the durable primitive: `experimental_startVideo`
returns a JSON-serializable `operation` that `experimental_getVideoStatus` can
check from any process. All seven supported providers (Google Veo, xAI, fal,
Replicate, Doubao and Volcengine Seedance, Qwen Wan) implement it.

## Decision

### 1. One engine, durable rows

`lib/ai/media/video-jobs/` starts a job with `startVideo` and writes a
`mediaGenerationJobs` row holding the request, the provider coordinates
(`providerId`, `modelId`, `baseURL`, credential affinity) and the opaque
`operation`. The base URL is stored because every provider except fal rebuilds
its status URL from the current configuration. Storage sits behind a port:
Dexie in the app, in memory in the CLI.

### 2. A renderer reconciler, one window at a time

An initializer holds a `navigator.locks` lock so one window polls. It checks
due rows with backoff, marks rows past a 30-minute deadline `timed_out` (a
user can check again), and resumes `generating` rows after a reload. A
status-guarded claim makes sure only one download happens.

### 3. Download once, never keep the URL

Providers return expiring URLs, and Google's carries the API key. The engine
downloads on the first `completed`, stores the bytes where the job was
requested (a session asset for chat, a Files upload for plugins, a file
under AppData for workflows), and discards the URL. The stored file is named
after the prompt. All traffic goes through
`platformFetch`, which fixes the desktop CSP gap for every caller. The desktop
bridge buffers up to 64 MiB; larger results fail early from a
`Content-Length` check with `result_too_large`.

### 4. Surfaces are adapters

- An agent tool `video_generate` returns a job id at once (approval: ask),
  with a read-only `video_status`. It is not offered in IM-bound sessions
  or the CLI. A finished job does not start a new agent turn; the chat card
  plays it.
- `/video` starts a job without an agent turn and writes a system message
  carrying the job's id to the transcript; the card reads the job's row, so
  it follows the job with no further writes. A staged image becomes the start
  frame (stored as an asset of the conversation) and is left out of the turn.
- Jobs are not synced. A companion viewing the conversation from another
  device shows the card as "not stored on this device".
- A "Media generation" settings section holds defaults; every surface can
  override them per call.
- On the Files page a generated video is the upload its job stored, not a
  card of its own, so keeping, moving and deleting it work as for any upload.
  The aggregate folds in what the job recorded (prompt, provider, model,
  duration, size) for the preview and for search. A Video type filter covers
  every video upload, and the preview plays it. The job row goes with the
  conversation that started it, so the record is also copied onto the Files
  item that outlives it: when the video is kept, and when the conversation is
  deleted (onto its kept upload and any Files upload of the same bytes).
- A workflow node `action.media.generateVideo` waits on its job and outputs the
  file's path, which the other `action.media.*` nodes read. The file lives
  under AppData, the one tree the window may write without a wider fs scope;
  like the trim and concat outputs it is outside every workspace root. Its
  saved defaults are the same as `/video`'s. The node does not retry, since
  each start is a paid generation. The file sits in a directory of the
  account and database whose row points at it
  (`generated-videos/<account>/<database>/`), as do the composer's FFmpeg
  staging copies, so "clear all data" and account deletion remove them
  without opening the database. The retention sweep removes what no row
  accounts for: a dropped database's directory, a video whose job is gone,
  a staging copy older than a day.
- The plugin API and the executor's `videos.*` handlers call the engine.

### 5. Cancel is honest

The SDK has no cancel. Providers with a cancel endpoint (Replicate, fal, Ark,
DashScope while pending) are cancelled remotely; for the others the UI says
cancelling only stops waiting and the provider may still bill.

### 6. Web is labeled, not guessed

On the web build a provider not known to accept browser requests is listed
but inert, labeled "desktop app required", documented at its type and pinned
by a test.

## Delivery

1. The engine, the `mediaGenerationJobs` table (schema v234), the reconciler,
   and the plugin API and executor `videos.*` moved onto the engine.
2. The "Media generation" settings section, the `video_generate` /
   `video_status` agent tools, `/video` and the chat job card (including
   "check again" for a timed-out job).
3. The Files Video filter, preview and job details, and the
   `action.media.generateVideo` workflow node.

Step 1 shipped with no chat origin in use; the engine, storage, backup and
session cascade already handled one, and step 2 uses it.

## Consequences

- Video generation works in the packaged desktop app and survives reloads.
- The existing plugin video API starts working on the desktop, keeps its
  signature, and leaves a Files entry behind.
- A new Dexie table joins the backup; failed and cancelled rows are pruned
  after 30 days, succeeded rows follow their session. A succeeded workflow
  job's row and its file are pruned after 30 days too.
- The provider-operations `videos.generate` for the seven media-module
  providers now answers `running` with a `vjob_…` handle instead of waiting
  for the video; `videos.get` checks the job with the provider and
  `videos.content` returns the bytes once it has succeeded. In the CLI the
  job lives in memory for the life of the process.
- No poster image is stored. A poster in the media store would be referenced
  by a job row rather than a message, which media garbage collection does not
  see; the player draws the video's own first frame. Duration and size are
  read from the file where the shell can decode it.
- Outputs over 64 MiB fail on the desktop until a streaming native download
  exists.
- Polling stops while every window is closed; results are still retrieved on
  the next launch while the provider keeps them.

## Alternatives rejected

- **Extend the executor's handle contract to carry the operation.** More
  contract surface across packages for the same work; the job id serves as the
  handle id instead.
- **A Rust job runner.** Survives closed windows and removes the size cap, but
  re-implements seven vendors' REST APIs beside the AI SDK. Revisit only if
  those become requirements.
- **A `supportsVideoGeneration` model capability.** Video models are not in
  the provider catalogs; `VIDEO_PROVIDERS` is already the single source.
- **Reusing the background-task registry.** It is typed and delivered for
  subagents.
