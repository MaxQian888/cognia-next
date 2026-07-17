---
"cognia-next": minor
---

Auto-play read-aloud now starts speaking while the assistant is still replying, instead of waiting for the whole message. When auto-play is on, the reply's text is fed to the voice engine as it streams: an incremental splitter cuts the first speakable fragment as soon as enough text arrives (and sentence-by-sentence after that), so first audio starts much sooner. Fragments always play in order, the tail is flushed on completion, and the message is never read twice.
