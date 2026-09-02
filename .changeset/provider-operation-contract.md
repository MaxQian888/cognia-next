---
"cognia-next": minor
---

Provider operation plane (ADR-0163). Every provider capability is one of fifty named operations in a single contract, served by built-in handlers for language, retrieval, media, files, vector stores, batches, fine-tuning, video jobs, realtime sessions, account reads and discovery. The provider settings surface shows the resulting capability cells with `unsupported` reasons instead of `unknown`. The CLI gains `cognia-agent provider <capabilities|models|balance|limits|usage|probe>`, and the TUI gains `/models`, `/balance` and `/provider usage|inspect|capabilities|probe`, all answering from the running desktop, a configured cognia-server, or the process itself. `/doctor` reports the active provider's operation profile and a read-only disk report. Plugins can serve an operation through the new `provider-operation-adapter` capability, and existing balance adapters, limits sources and protocol adapters now appear as plugin cells in the capability matrix.
