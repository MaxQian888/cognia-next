---
title: "0180 — A video reaches the model as what it can read"
description: "The composer refused every video and silently flattened large GIFs. Videos and animated GIFs now become a storyboard or frames at staging time, with trim, scene-change sampling and an original-file option that is offered only where the model and the route can take it, and re-checked after the route resolves."
---

# ADR 0180 — A video reaches the model as what it can read

**Status:** Accepted
**Date:** 2026-09-14
**Related:** [ADR-0168](./0168-an-edit-is-a-new-version-of-the-same-message) (the image engine the storyboard reuses), [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (runtime adapters)

## Context

Three facts about the composer before this change:

- **Every video was refused at intake.** `isSupportedAttachmentDescriptor`
  (`lib/chat/attachments/prepare.ts`) accepts images and documents only. The
  vendored chip's `<video>` preview was unreachable.
- **GIF was half handled.** Intake skipped the downscale to keep the animation,
  but dispatch ran `downscaleImage` on every image, so a GIF with a long edge
  over 1568 px was re-encoded by canvas into its first frame without a word.
  Below that it shipped as `image/gif`, and a model reads one frame of it.
- **Nothing on the send path read `supportsVideo`.** The catalog flag existed;
  no route decision consulted it.

Only one provider path in the sidecar can carry a video file today:
`@ai-sdk/google` maps any file part to `inlineData`. `@ai-sdk/openai` throws on
`video/*`, so models such as Kimi or Qwen that declare `supportsVideo` still
cannot receive the file through their OpenAI-compatible protocol, and Anthropic
has no video input at all.

## Decision

Decisions D1–D8 were settled with the user in two rounds on 2026-09-14.

### 1. Frames by default, the original only where it can land (D1, D5)

An untouched video becomes a **storyboard**: one image of 9 evenly spaced,
timestamped frames, preceded by a description block that names the clip, its
duration, the grid and the frame times. The panel also offers **frames**
(separate images) and **original video**.

The original file is offered only when all of these hold (`delivery-gate.ts`):

`supportsVideo` ∧ runtime adapter `ai-sdk` ∧ protocol `google` ∧ not an IM
platform binding ∧ not a team room ∧ not a shared collaboration ∧ not an
external-agent lane ∧ not standalone (in-renderer BYOK) mode ∧ not auto
routing ∧ the prepared file ≤ 10 MB.

A disabled option always says why (`nativeReason.*`); it is never hidden.

### 2. The composer predicts, the controller decides

The composer reads the model the way `ModelPicker` labels it
(`useComposerVideoRoute`). `resolveSendOptions` can still resolve another
model: an alias, a character default, auto routing. So after it resolves,
`enforceVideoDeliveryForRoute` re-checks every original-video payload against
the resolved provider, model and runtime adapter, and swaps in the storyboard
the manifest carries for exactly that case, with a toast. A payload that would
make the provider reject the request cannot reach it.

### 3. GIF joins the pipeline (D2)

An animated GIF is decoded by `lib/images/gif.ts`, a pure decoder (LZW,
interlace, disposal 0–3, transparency) checked pixel-exact against ffmpeg's
compositing. A single-frame GIF stays an image. Large GIFs are no longer
flattened by a path nobody could see.

### 4. Preprocessing in v1 (D3, D6)

Trim range, sampling strategy (uniform or scene change), and frame count, all
applied on demand from the preview sheet's model tab. Scene change scores a
16×16 luma signature per candidate frame and keeps the largest cuts. No audio
transcription.

Trimming an original video needs a re-encode, which only desktop ffmpeg can do.
Without it the range control is disabled for that option, with the reason.

### 5. Browser first, desktop ffmpeg second (D4)

Sampling seeks a `<video>` element and draws to canvas. When the webview cannot
decode the file and the app runs on the desktop host (by host profile, not
`isTauri`), `crates/cognia-media` ffmpeg opens it through the existing
`video_get_info` / `plugin_media_get_video_frame` / `plugin_media_export_video`
commands, with the source staged under AppData and removed afterwards. Other
shells refuse with the reason (`ffmpeg: not-available-here | missing | failed`).

### 6. The transcript keeps what the model saw (D7)

The original file is not stored. Every part a video produces carries one
`VideoAttachmentInfo` under `videoAttachment`, and
`MessageVideoAttachmentCard` folds them into one card: name, duration,
geometry, what was sent, the range, the frames or poster, and a note that the
file itself is gone. The description text is excluded from edit, quote and
copy.

### 7. Ceilings (D8)

A 500 MB source ceiling. An original video is at most 10 MB, and the derived
images are at most 10 MB, re-encoded at a lower quality once before refusing. A
draft keeps a video's bytes only up to 10 MB; beyond that it restores as a
reminder chip, and the sampling settings always persist with the draft.

## Consequences

- IM platform sessions keep forwarding files to a person as they are: the file
  picker does not offer videos there, and the motion pipeline is off.
- The remote-session composer on a paired phone is unchanged. It uploads
  original bytes to the Host through the shared upload gate, and that gate
  (`isSupportedAttachmentDescriptor`) deliberately still refuses video, so a
  500 MB file never goes over 32 KiB chunks.
- Scene sampling seeks four candidates per requested frame. On a file with few
  keyframes each seek decodes from the previous keyframe, so a long,
  sparsely-keyed clip takes seconds; progress is shown on the chip and in the
  panel, and a re-apply cancels the run it replaces.
- Adding a provider protocol that can carry video means adding it to
  `NATIVE_VIDEO_PROTOCOLS` and proving the sidecar mapping, not flipping a
  model flag.

## Not in v1

Audio transcription; video in the paired-phone composer and IM sessions;
recording video from the mobile camera.

## Implementation

`lib/images/gif.ts`, `lib/media/native-video-frame.ts`,
`lib/chat/attachments/video/` (classify, settings, timeline, storyboard,
describe, delivery-gate, route-facts, route-guard, frame-source, gif-source,
browser-source, ffmpeg-source, preprocess, attachment-info), `prepare.ts`,
`dispatch.ts`, `lib/claude/adapter.ts`, `hooks/chat/use-claude-chat-controller.ts`,
`components/chat/composer/{staged-attachment-store,video-preprocess-panel,attachment-preview,attachment-preview-sheet}.tsx`,
`components/chat/composer/hooks/use-composer-video-route.ts`,
`components/chat/renderers/message-video-attachment-card.tsx`,
`components/chat/message-renderer.tsx`, `lib/chat/draft-attachments.ts`,
`lib/db/chat-drafts.ts`. Dynamic i18n keys are pinned by
`components/chat/composer/video-dynamic-keys.test.ts`.
