---
"cognia-next": patch
---

Model catalog search finds video, transcription and moderation models instead of returning nothing.

Catalog schema v2 widened the modality enum with `video`, `transcription` and `moderation`, and the search filter was never taught about them. It answered `undefined` for each, which is falsy where it is used, so filtering on any of the three matched no model at all rather than failing in a way anyone would notice. The three now resolve, reading the offering's endpoint type, which for moderation is the only signal there is: nothing on a model definition distinguishes a moderation model from any other text-in, text-out model. Transcription is deliberately audio-in and text-out rather than reusing the speech test, so text-to-speech models no longer answer for it. The five modalities that already worked are untouched.
