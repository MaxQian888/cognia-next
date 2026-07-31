---
name: OCR result handling
description: How to work with text extracted from images or scanned documents via OCR. Use whenever you are reading, quoting, or acting on OCR output — to account for recognition errors, respect low-confidence regions, preserve document layout and structure, and avoid presenting a noisy scan as if it were clean ground truth.
category: data-analysis
tags:
  - ocr
  - extraction
metadata:
  surface: []
---

OCR text is a best-effort guess at what's on a page, not a faithful transcript. Characters get confused (0/O, 1/l/I, rn/m), whitespace and column structure get mangled, and faint or rotated regions come out garbled. Treat the extracted text accordingly.

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
