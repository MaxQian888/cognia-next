---
"cognia-next": minor
---

Make local model provider management work in the desktop app

Scanning, model listing, pull, delete, stop and Ollama embeddings were dead in the packaged desktop build: they called Tauri commands that had never been implemented, and the HTTP fallback was blocked by the renderer's content-security policy. Chat was unaffected, which is why the breakage went unnoticed. Management calls now reach local servers through the Rust HTTP proxy, model pull reports real streaming progress with an honest indeterminate state while the server sends no byte counts, and installed models show capability badges (vision, tools, embedding, reasoning) and context length probed from the server rather than guessed from the model name. Embeddings are batched into a single request per batch. The provider list no longer shows an "installed" count it cannot actually determine, a moved server port is now probed where it actually lives, and stopping a pull says plainly that the download continues in the background — Ollama's server cannot cancel one.
