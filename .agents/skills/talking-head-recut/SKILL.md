---
name: talking-head-recut
description: >
  Package an existing talking-head, interview, or podcast video with timed graphic overlays such
  as kinetic titles, lower-thirds, data callouts, quotes, side panels, and picture-in-picture. Use
  when the source clip must play unchanged beneath designed, transcript-synchronized cards. For
  plain subtitles use embedded-captions; for retiming, reordering, or remixing footage use
  general-video; when routing is unclear use hyperframes.
---

# Talking Head Recut

Use this checked-in workflow as the source of truth. Never self-update vendored skills during a task; upstream refreshes are separate, reviewable repository changes.

This workflow preserves the source clip from beginning to end and adds designed HTML cards over or beside it. It does not cut the speaker, rewrite the footage, or substitute plain captions for graphic packaging.

## Inputs and outputs

Required input: one local video file. Read an existing `BRIEF.md` first. The `$hyperframes` intent layer owns route selection and confirms the clip; aspect, layout, style, and card density are deferred until the footage and transcript can ground a recommendation.

Keep all generated artifacts in `videos/<project>/`:

- `metadata.json`: probed duration, dimensions, and frame rate
- `audio.mp3`: extracted audio
- `transcript.json`: flat word array `{ text, start, end }[]`
- `storyboard.json`: the card plan
- `public/cards/card-XX.html`: one authored card per file
- `public/index.html`: assembled HyperFrames composition
- `output.mp4`: final render

Do not delete the work directory unless the user asks.

## Required references

Read `references/DESIGN_INDEX.md` before choosing a visual direction. It routes the checked-in, self-contained references:

- `references/styles/*.html`: card visual language
- `references/layouts/*.html`: video/card placement recipes
- `references/frames/*.html`: video chrome

Choose style, layout, and frame independently per card. Copy only the relevant reference, replace placeholder content, and keep the card’s stable ID. For composition structure, timing, deterministic animation, and media ownership, also load `$hyperframes-core`; use `$hyperframes-animation` or `$hyperframes-keyframes` only when the chosen motion requires them.

## Workflow

### 1. Verify the environment

Run commands through the repository wrapper:

```bash
rtk pnpm dlx hyperframes doctor
rtk ls <SKILL_DIR>/assets/fonts <SKILL_DIR>/assets/vendor/gsap.min.js
```

The workflow requires `ffmpeg`, `ffprobe`, a render-capable browser, the bundled fonts, and the bundled GSAP file. Stop and report missing requirements; do not install or authenticate external tools without approval.

### 2. Create the isolated work directory

Resolve the absolute video path and a safe project slug. Create only `videos/<project>/` and its `public/cards/`, `public/fonts/`, and `public/vendor/` children. Copy the input into the project so the render is reproducible. Never write generated media into application source directories.

### 3. Probe and transcribe

Use `ffprobe` to write duration, dimensions, and frame rate to `metadata.json`, then use `ffmpeg` to extract `audio.mp3`. Prefix both commands with `rtk`.

Transcribe locally:

```bash
rtk pnpm dlx hyperframes transcribe <work-dir>/audio.mp3 --dir <work-dir> --json --model small.en
```

`transcript.json` is a flat word array, not a `segments` object. Correct obvious names, homophones, and punctuation in `text` only; preserve timestamps. Group words into sentences using punctuation and pauses. Clamp every planned end time to the probed media duration so the render cannot acquire a black tail.

### 4. Plan the cards

Write `storyboard.json` before authoring HTML. Use this stable shape:

```json
{
  "schemaVersion": 3,
  "composition": {
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "durationSeconds": 60,
    "layout": "landscape",
    "themeId": "editorial",
    "seed": 42
  },
  "videoTrack": {
    "sourcePath": "input.mp4",
    "startSec": 0,
    "endSec": 60
  },
  "subtitles": { "enabled": false },
  "cards": [
    {
      "id": "card-01",
      "intent": "Establish the speaker and central claim",
      "startSec": 1.2,
      "endSec": 7.8,
      "accentIndex": 0,
      "zone": "lower-third",
      "contentHints": {
        "kicker": "CONTEXT",
        "title": "The actual takeaway",
        "detail": "Short evidence grounded in the transcript"
      }
    }
  ]
}
```

Each card requires `id`, `intent`, `startSec`, `endSec`, `accentIndex`, `zone`, and `contentHints`. Valid zones are `fullscreen`, `whiteboard-area`, `lower-third`, `side-panel`, and `video-overlay`. Avoid overlaps unless they are intentional and assigned explicit `data-track-index` values.

Choose cards for information value, not sentence count. Typical useful moments are the opening identity, a key claim, named data, a quote, a comparison, and the close. Keep enough uninterrupted speaker-only time that the package does not become a slide deck.

Present a compact card plan and a grounded recommendation for aspect, card density, and visual direction. Obtain approval before the full card build when the run is collaborative. A storyboard preference changes the review surface, not this workflow’s ownership.

### 5. Author static cards first

Build each `public/cards/card-XX.html` at its fully visible hero state before adding motion. Cards that share the canvas with video must have transparent roots; an opaque background is appropriate only for a genuinely full-screen card or the card’s bounded side panel.

Requirements:

- real transcript-grounded content, no placeholder copy
- readable typography at the delivery aspect ratio
- bundled/local fonts with concrete `font-family` names
- stable `data-card-id` matching `storyboard.json`
- no network-loaded runtime assets
- no hard-coded caption duplication when subtitles are disabled

### 6. Assemble the composition

Copy bundled fonts and GSAP into `public/`, then author `public/index.html` using `$hyperframes-core`.

- The root declares composition dimensions and exact media duration.
- The source video is framework-owned and spans the full duration.
- Every timed card host has `class="clip"`, `data-start`, `data-duration`, and `data-track-index`.
- Video framing changes animate `#video-wrap`, not the video element’s intrinsic dimensions.
- Register one paused, synchronously constructed master timeline in `window.__timelines`.
- Use deterministic values: no `Math.random()`, `Date.now()`, asynchronous timeline construction, media `play()` calls, or infinite repeats.
- Prefer transform/opacity animation. Avoid competing timelines on the same property.
- Confirm cards, speaker framing, captions, and diagrams do not unintentionally overlap.

The source clip must remain temporally untouched. If the requested result needs cuts, reordered speech, speed changes, or source replacement, stop and reroute to `$general-video`.

### 7. Verify, review, and render

Run the fast checks and inspect proof frames before rendering:

```bash
rtk pnpm dlx hyperframes lint <work-dir>/public
rtk pnpm dlx hyperframes check <work-dir>/public
rtk pnpm dlx hyperframes snapshot <work-dir>/public --at <proof-times>
```

Proof times must include the opening, each distinct layout, dense cards, overlaps, and the final frame. Inspect the PNGs for clipping, unreadable text, hidden faces, opaque overlay roots, missing fonts, and black tails.

Open the final preview only when requested or when the active review loop requires it. Render only after final approval:

```bash
rtk pnpm dlx hyperframes render <work-dir>/public --skill=talking-head-recut --output <work-dir>/output.mp4 --fps 30
rtk test -s <work-dir>/output.mp4
rtk ffprobe -v error -show_format <work-dir>/output.mp4
```

## Completion report

Report the work directory, storyboard, card files, composition, final MP4, transcription method, card count, and any quality caveats. A successful run requires all of the following:

- source duration and output duration are plausibly equal
- lint and check pass
- proof frames cover every distinct layout and show no blocking defect
- the approved MP4 exists and is non-empty
- no skill self-update, telemetry, publication, or external authentication occurred without explicit user approval
