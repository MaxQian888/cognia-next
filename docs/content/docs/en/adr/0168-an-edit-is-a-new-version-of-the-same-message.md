---
title: "0168 - An edit is a new version of the same message"
description: "Chat images were a dead end: a read-only lightbox over pixels nobody could touch, while the plugin Media API carried a half-implemented image engine that advertised eleven adjustments and applied four. Editing a conversation's image is now first-class, and the result is a new version appended to the message it came from rather than a replacement of it."
---

# ADR 0168 - An edit is a new version of the same message

**Status:** Accepted
**Date:** 2026-09-05
**Related:** [ADR-0027](./0027-mobile-sync-orchestrator), [ADR-0063](./0063-optical-compaction), [ADR-0139](./0139-artifacts), [ADR-0155](./0155-plugins-reach-the-host-through-one-door), [ADR-0163](./0163-provider-operation-contract)

## Context

An image in a conversation was the end of the road. `ImageLightbox` could zoom
it, rotate the view, page across the turn and download it, and that was the
whole vocabulary. Anything further meant downloading the file, opening another
application, and pasting the result back as a new message, which loses the
thread that connected the two.

Meanwhile the app already contained most of an image editor, in the wrong place
and half-finished. `lib/plugin/api/media-api.ts` carried canvas helpers for
loading, resizing, transforming and adjusting images, plus a hand-rolled
multipart POST to a provider's `/images/edits` endpoint with its own base URL
normalisation, its own timeout and its own xAI special case. Its
`ImageAdjustmentOptions` advertised eleven adjustments and implemented four.
Exposure, gamma, vibrance, temperature, tint, blur and sharpen were accepted
from a plugin, discarded, and the unchanged input returned with no error. Its
contrast curve fed a 0..2 scale into a formula that expects -255..255, so past
about plus or minus 40 the factor went negative, inverting the image and then
clipping it to pure black and white.

Two surfaces wanting the same capability, one of them lying about what it does,
is the shape of a missing shared component.

## Decision

### One image engine, pure except at the edges

`lib/images/` owns decode, crop, resize, rotate, flip, adjust, mask and encode
for the whole app. Everything except `codec.ts` is arithmetic over a structural
RGBA buffer with no canvas anywhere, which has two consequences worth stating.
The maths is unit-tested in the fast `node` Jest project rather than jsdom. And
the results are deterministic: a canvas `drawImage` resample is whatever the
host's graphics stack decides that day, so two shells could otherwise disagree
about the bytes of the same edit, in a store that addresses content by hash.

The plugin Media API delegates here. All eleven adjustments now run, and the
contrast mapping is the linear one.

### The mask convention inverts exactly once

Inside the app a mask is greyscale where white means "edit here". That is what
the workbench paints and what the overlay draws, because a bright brush over
the region about to change is what a user expects to see.

At the provider boundary the convention is the opposite: the OpenAI
`images/edits` endpoint reads fully transparent pixels as the region to edit,
and the AI SDK passes the mask through unchanged. `maskToProviderBuffer` is the
only function permitted to perform that inversion.

This is called out because getting it backwards fails silently. The provider
edits the complement of the selection and returns a plausible image, so the bug
reaches the user as "the AI changed the wrong part of my photo" with nothing in
any log to explain it.

### Editing routes through the provider operation plane

There is exactly one path to a model: `images.edit` on the operation plane
(ADR-0163). Duplicating the plugin API's hand-rolled request for chat would
have meant two places to fix every provider quirk and two places to forget the
PII gate. Routing, proxying, credential affinity, the gate and failure
classification are all already decided there.

A provider whose edit endpoint takes no mask still does whole-image prompt
edits. Region editing is disabled and explained rather than the panel being
hidden, because hiding it would hide a capability the provider does have.

### A saved edit is appended, never substituted

The original part is never rewritten. The result is added to the same message
as another `file` part carrying a `cogniaImageEdit` record, and the version
rail keeps the original one click away.

The field is additive and ignorable. A client that predates it sees an ordinary
image file part and renders it as one, which is the correct degradation: an
extra thumbnail at the end of the message rather than a broken one. This is
also why the feature needs no Dexie migration.

**The lineage id is the original part's url**, not a minted identifier. Minting
one would require writing to the original on first edit, which is exactly the
destructive write this design exists to avoid, and it would leave every image
saved before this feature outside any lineage. Keying on the url makes version
0 implicit, needs no backfill, and is stable across devices because chat media
is content-addressed.

**The append re-reads the message inside its transaction.** An editing session
is long: open the workbench, drag a crop, wait for a model. In that window the
same message can be rewritten by a streaming turn, a sync leg or another
device. Writing a caller-held snapshot back would silently undo all of it.

**`versionId` is the idempotency key**, minted by the caller and reused across
retries. A double-clicked save, a transport that retried, and a client
reconnecting after a failure must all produce one version rather than three.

### Two resolutions, and the reason for each

A canonical chat image is 1568px, so one tone adjustment touches roughly 2.5
million pixels, which cannot keep up with a slider being dragged. The preview
renders from a downscaled copy with the geometric steps scaled by the same
factor, and the save re-renders the same history at full resolution.

Every geometric step must scale by the same factor or the pipeline stops
composing, because a crop's coordinates are relative to whatever the step
before it produced.

### Local steps and AI steps share a timeline but not a ceiling

A crop is a description worth a few dozen bytes that can be replayed. An AI
result is a decoded frame worth megabytes that cannot be recomputed from
anything. So the history keeps fifty local steps and five AI checkpoints, and
rendering walks back to the most recent checkpoint and replays only what
follows it. Replaying the steps before would apply them twice, since the
model's output already contains them.

A step that falls out of the undo window is still in the pixels, so it moves to
a baked list that is replayed but no longer undoable, and the discard prompt
still counts it. A checkpoint that falls out becomes the new origin, which is
what makes the evicted bitmap safe to release rather than held for the life of
the editor.

### Encoding follows the content, not the request

A locally edited photo is stored as WebP at 0.92. A result carrying
transparency is stored as PNG regardless of preference, so a background removal
is not flattened onto black. An untouched model output keeps the provider's own
bytes, because re-encoding identical pixels can only lose quality.

The media type recorded always describes the bytes produced, never the format
requested. A runtime with no WebP encoder answers a WebP request with a PNG,
and trusting the request would mislabel those bytes permanently in a
content-addressed store.

### What is recorded, and what is not

The version records the KIND of edit (`crop`, `adjust`, `ai.region` and so on),
when it happened, and for a model edit the provider and model. It does not
record the prompt. That is user input which already went to a model, and
keeping a copy in the transcript would put it into every backup and every sync
leg for no product benefit.

Only the LAST model step is attributed. An earlier one contributed to the
image, but the record names who produced this result, and claiming two models
made one image would be worse than naming the one that finished it.

### Unavailability is stated, not hidden

Three cases where a control would otherwise silently vanish:

- An image from another origin renders and downloads normally but its pixels
  cannot be read back. It is viewable and not editable, and the workbench says
  which.
- A provider with no mask support disables region editing and names itself in
  the reason.
- A streaming turn or a handoff-locked conversation greys the save button and
  explains why rather than removing it. The database guard remains
  authoritative either way. The UI check only decides whether to offer a button
  that would otherwise spend a full re-encode before failing.

## Consequences

Chat images stop being a dead end, and the plugin Media API stops advertising
capabilities it discards. Both surfaces produce identical pixels for identical
settings, because there is one engine.

Nothing is migrated. Every image saved before this feature is version 0 of its
own lineage by construction, and no historical message is touched.

The version chain lives on the message, so it survives a refresh, travels
through backup and export with the transcript, and reaches other devices
through the existing sync path with no new table.

Editing needs local pixel access, which a companion client driving a remote
host does not have for the host's media. Making that work needs the result to
be staged and committed through the host rather than written directly, which is
the subject of a follow-on slice and is deliberately not claimed here: on such
a client the workbench opens, views, edits locally and downloads, and reports
that saving needs the host.
