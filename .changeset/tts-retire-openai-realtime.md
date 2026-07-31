---
"cognia-next": minor
---

Retire the OpenAI Realtime TTS provider. Using OpenAI's speech-to-speech Realtime model purely as a text-to-speech engine costs roughly $64 per 1M audio tokens versus about $12 for `gpt-4o-mini-tts`, and it had to be steered by a "read this verbatim" prompt to stop the model from answering rather than narrating — the wrong tool for the job. The regular OpenAI provider already uses `gpt-4o-mini-tts` over REST (with its `instructions` styling), so that is the read-aloud path now. Realtime is removed from the provider picker (a persisted selection still resolves and shows a retired notice); its speech-to-speech transport is kept, reserved for a future real-time voice-conversation feature.
