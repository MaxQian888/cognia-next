---
"cognia-next": minor
---

Plugins can process local video natively. A new Rust crate owns FFmpeg/FFprobe discovery, metadata probing, frame extraction, focused analysis, near-duplicate frame removal and trimming, exposed to plugins through the media API — so a plugin asking for a video's duration, a frame at a timestamp, or a trimmed clip no longer gets a runtime rejection. Missing FFmpeg is reported as a named dependency error rather than a generic failure, and every step is bounded by its own timeout.
