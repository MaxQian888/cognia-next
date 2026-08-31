---
name: OCR result handling
description: Extract and use OCR text with layout, confidence, PII, provenance, and error-aware verification.
category: data-analysis
tags:
  - ocr
  - extraction
metadata:
  default-enabled: true
  delivery: catalog
  triggers:
    surfaces: []
    intents: [extract-text-from-image, read-scanned-document, verify-ocr-output]
  capability-requirements:
    - capability: ocr
      reason: text extraction requires a host-projected OCR backend
  host-policies: [permission-ceiling, pii-gate, user-language]
---

OCR text is a best-effort guess at what's on a page, not a faithful transcript. Characters get confused (0/O, 1/l/I, rn/m), whitespace and column structure get mangled, and faint or rotated regions come out garbled. Treat the extracted text accordingly.

Use only the OCR backend and source image the host made available. If OCR is unavailable, say so; do not substitute invented text or send the image to an unapproved cloud service.

## Read with the error model in mind
- When a number, code, date, or identifier looks off, flag it rather than trusting it — a transposed digit in an invoice total or an account number is the kind of error OCR makes constantly and the kind that costs the most.
- Use surrounding context to sanity-check tokens. If a "total" doesn't equal the sum of line items, the OCR likely misread a digit; say so instead of silently propagating it.

## Respect confidence
- Where the source marks regions as low-confidence, treat those as uncertain. Don't quote a low-confidence string as an exact value; note that it's unclear and, if it matters, suggest the user verify against the original.
- Blank or nonsense stretches usually mean the OCR failed on that region (a stamp, handwriting, a photo) — not that the page was empty. Don't infer meaning from garbage.

## Preserve structure
- Layout carries meaning: tables, columns, headings, form fields. Reconstruct the structure when you present extracted content rather than flattening a form into a wall of text.
- Keep the reading order sensible. Multi-column scans often come out interleaved — reorder into the order a human would read.

## Be honest about provenance
When you report what a document says, make clear it came from OCR if accuracy matters. For anything consequential — legal, financial, medical — recommend checking the extracted value against the original image rather than acting on the recognized text alone.

For the character-confusion table and validation strategies by document type, see `references/error-patterns.md`.
