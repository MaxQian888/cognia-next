---
"cognia-next": minor
---

Add an opt-in macOS flow that reuses sign-in cookies from a selected Chrome, Edge, Brave, or Chromium profile in the embedded browser. Cookie values are decrypted and injected entirely inside Rust, while Windows and Linux return an explicit unsupported result without bypassing their credential protections.
