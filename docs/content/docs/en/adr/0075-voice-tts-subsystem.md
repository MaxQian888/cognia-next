---
title: ADR-0075 — Voice / TTS subsystem
description: "Own the previously-undocumented voice/TTS subsystem: stream read-aloud from the assistant's tokens, retire the impersonation-based Edge provider and the misused speech-to-speech Realtime TTS path, reserve a native-audio option for future real-time voice conversation, structure provider errors, give the desktop pet a voice, and record the dormancy verdicts."
---

# ADR-0075 — Voice / TTS subsystem

**Status**: Accepted (2026-07-17)

## Context

The voice/TTS subsystem (`packages/tts/`, `crates/cognia-tts/`, `lib/tts/`,
`components/settings/speech/`, `app/me/speech/`, plus the desktop pet) was real
and substantial — eleven providers, an adapter registry, a request-id
cancellation model, an IndexedDB audio cache — but **no ADR had ever recorded
its design**, and an audit surfaced live defects: read-aloud text was mangled
(headings read as "number", code blocks spoken), first-audio latency equalled
"whole reply generated + whole reply synthesized", cache keys collided, the
Realtime cancel could be lost during the WebSocket handshake, and provider
errors collapsed to a single opaque string. The Edge provider only worked by
impersonating the Edge browser, and the Realtime provider used a
speech-to-speech model as a plain TTS engine at ~5× the cost. The pet had a full
Live2D/SVG rig but never spoke.

## Decision

- **Streaming read-aloud (D3).** The orchestrator gains `speakStream`, fed by an
  incremental sentence splitter (a wide separator set for a fast first fragment,
  sentence enders after). Auto-play diffs the assistant's growing text off the
  chat store and feeds it as it streams, so first audio starts before the reply
  is finished. Fragments always play in order; `speak(string)` is unchanged for
  callers that already hold the finished text.

- **Retire Edge (O2).** Edge-TTS is removed from the provider picker. It only
  functioned by forging a token from a constant lifted out of the Edge browser
  plus a spoofed user-agent and Origin, has no acceptable terms of service, and
  returns 403 in mainland China. A persisted selection still resolves and shows
  a retired notice; the code stays one release before deletion.

- **Retire Realtime as a TTS provider (D2), reserve its transport (O1).** Using
  the speech-to-speech Realtime model purely for TTS costs ~$64/1M audio output
  vs ~$12 for `gpt-4o-mini-tts` (which the `openai` provider already uses over
  REST with its `instructions` styling), and needed a "read this verbatim"
  prompt to suppress the model's agency. It is retired from the picker; the
  speech-to-speech WebSocket transport (`crates/cognia-tts/src/realtime.rs`,
  `providers/openai-realtime.ts`) is **kept, reserved for a future real-time
  voice-conversation feature**. That reservation is the reason audio ownership
  is left open: macOS acoustic echo cancellation requires one process to own
  both the input and output streams, so playback must not be permanently locked
  into the WebView. The native Rust audio path is currently empty, so this
  remains a free choice; the Realtime cancel race was still fixed (a
  state-storing `watch` signal) so the reserved chain is correct for future use.

- **Pet voice.** The pet reads its LLM replies aloud through the shared
  orchestrator in the bound character's voice (reusing `resolveCharacterVoice`),
  a no-op when TTS is off. Mouth-follows-voice (RMS envelope → the existing
  seven-shape rig) is **deferred**: real amplitude requires capturing the shared
  `<audio>` output through Web Audio, and the default system voice exposes no
  audio node. The synthetic mouth-flap continues to run during pet speech.

- **Correctness fixes.** Text normalization strips structure before collapsing
  whitespace and substituting symbols; language is detected from the reply text
  (not the microphone setting) and kana wins over kanji; cache keys are SHA-256
  under a version prefix; the desktop proxy is constrained to an https allowlist
  of provider hosts with timeouts, a body cap, and errors that never echo the
  URL or key; the Rust keyring list is pinned to the TypeScript source; the
  CJK pronunciation dictionary matches as substrings. Provider failures now
  carry the error kind, HTTP status, and provider message, so the real reason is
  shown and retry classifies by status (a permanent 401 is not retried like a
  transient 503).

- **Parity over hand-sync (D5).** Divergences (the missing `xiaomi` keyring
  entry, a stale provider-count pin) are fixed *and* pinned by a test so the
  next provider can't regress the same way.

- **Compliance and IM voice, planned (O4, O5).** Content Credentials via
  `c2pa-rs` (satisfying both the EU AI Act Art. 50 provenance requirement and
  China's labelling metadata) and first-party IM voice replies (a transcode plus
  a voice-segment producer) are accepted in principle and scheduled as follow-up
  work. Voice **cloning** is explicitly out of scope on ELVIS-Act grounds — only
  an authorized voice library is safe to distribute.

### Dormancy verdicts (W15)

- **Delete**: `providers/system.ts` (144 lines, imported only by its own test —
  the test masked the dormancy; the system voice is driven directly by the
  orchestrator).
- **Fixed**: the CJK pronunciation-dictionary matcher.
- **Marked / documented**: `generateSSML` is decorative-preview-only (the real
  synthesis path does not use it); `selectedMicId` is inert until `getUserMedia`
  passes a `deviceId` (activation path noted); the cache-management API
  (`clear`/`getStats`/`getCacheSize`) has no UI consumer yet. `TTSNormalizedError`
  is unused and superseded by the structured fields on `TTSResponse`.

### Provider and transport repair (2026-08-08)

- `local-openai-compatible` is the single stable local provider id. It does
  not bundle an engine: LocalAI, Kokoro-FastAPI, Piper, or another server is
  supported only when it exposes the OpenAI-compatible `POST /audio/speech`
  contract. Model and voice are manual because that contract defines no
  universal voice-discovery endpoint. The optional API key stays in the TTS
  keyring and never participates in cache identity.
- Its host transport accepts only HTTP(S) loopback targets (`localhost`,
  `127.0.0.0/8`, and `::1`) and never follows redirects. Normal desktop cloud
  calls also run host-side with credential injection; the renderer receives
  credential presence for the active provider, not stored secrets. Pure web
  calls remain best-effort and subject to explicit CORS/security warnings.
- Before any text reaches a cloud TTS adapter, the app host applies the shared
  outbound PII gate and returns a structured `pii-blocked` failure when the
  text is unsafe. Device system TTS and the loopback-only local provider never
  leave the device and are exempt from this cloud boundary.
- Buffered adapters accept `AbortSignal` and native request ids. `stop()`
  cancels active synthesis, retry backoff, and prefetch through
  `tts_proxy_cancel`; stale/cancelled results cannot play or enter the cache.
  The cache seam preserves the structured `TTSResponse` and stores successful
  audio only.
- Buffered HTTP providers no longer claim transport streaming. The persisted
  `ttsStreamingEnabled` flag is retained for compatibility but means “preload
  next segment”. Mobile playback always resolves to device system TTS; a cloud
  selection on mobile configures the desktop host only.
- Raw PCM is removed from ordinary buffered selectors. Legacy PCM settings
  normalize to MP3; headerless PCM is a structured unsupported-format error.
  MIME types are normalized from `Content-Type` with parameters removed; the
  selected format is used as fallback only for generic binary responses.
- ElevenLabs loads real account voice ids while retaining manual-id entry. A
  legacy saved name migrates only when it uniquely matches a discovered voice.
  Provider tests disable fallback and the test action becomes Cancel while a
  request is active.

## Consequences

Read-aloud narrates clean prose and starts sooner. Two structurally-unsound
providers stop being offered, without breaking existing selections. The pet
talks. Failures are actionable and retried sanely. The subsystem now has an
owner of record, and its provider list has a single source of truth. The
audio-ownership decision stays reversible because the Realtime transport was
reserved rather than deleted.

## Alternatives rejected

- **Fix Edge-TTS (implement the GEC token) instead of retiring it**: extends a
  strategically-dead, impersonation-based path that is already 403 in the
  product's own market.
- **Repoint `openai-realtime` to `gpt-4o-mini-tts` REST**: a pure duplicate of
  the `openai` provider with voice-compatibility risk; retiring it is cleaner.
- **A chat-core delta emitter for streaming TTS**: touches the large, sensitive
  chat event loop; diffing the growing store message is zero-risk by comparison.
- **Viseme-based lip-sync**: Live2D's mouth parameter is a scalar open amount
  that cannot express vowels, and only Azure exposes visemes; an RMS envelope
  matches the rig and the rest of the industry.
