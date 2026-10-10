---
"cognia-next": patch
"@cognia/redact": patch
---

Prevent renderer freezes when scanning large text uploads for PII. Scan email, URL credential, JWT, PEM and compressed IPv6 candidates without repeatedly backtracking over long runs, while preserving existing detection, redaction and normalization behavior.

Bound synchronous fallback token estimation for large uploads and unusually long tokenizer pieces by using the existing multilingual heuristic. Ordinary bounded inputs retain cl100k counts, and provider-reported usage remains authoritative.
