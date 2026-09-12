---
"cognia-next": minor
---

Cognia PDF plugin hardening: fix `pdf_fill_form` checkbox/radio semantics (boolean writes, radio-group selection, signature-field rejection — boolean fills previously corrupted button widgets), add `pdf_extract_text` (text layer + OCR fallback via the host OCR surface), accept PDF artifacts as `pdf_extract_pages` sources alongside attachment handles with per-source passwords, and make `pdf_validate`/`pdf_export` password-aware for encrypted documents. The importer now produces a real PDF artifact, imports are capped at 50MB, preview gains an error surface plus a download escape hatch, and inspection reports signatures via `getSignatures()` and embedded JavaScript via `hasJSActions()`.
