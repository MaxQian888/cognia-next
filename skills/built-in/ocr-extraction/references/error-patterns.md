# OCR error patterns

OCR is a guess at the page, not a transcript. Knowing how it fails tells you what to double-check.

## Common character confusions
| Often misread as | Watch in |
| --- | --- |
| 0 ↔ O ↔ Q | account numbers, codes |
| 1 ↔ l ↔ I ↔ \| | quantities, list markers |
| 5 ↔ S, 8 ↔ B, 6 ↔ G | totals, serials |
| rn ↔ m, cl ↔ d | words, names |
| . ↔ , (decimal vs thousands) | money, measurements |

A transposed or swapped digit in a number is OCR's most frequent — and most expensive — error. Treat any number that drives a decision as suspect until cross-checked.

## Validation by document type
| Document | Cross-check |
| --- | --- |
| Invoice / receipt | Line items sum to the stated total |
| Form | Field labels match expected schema; required fields present |
| Table | Row/column counts consistent; no merged-cell drift |
| ID / serial | Length and checksum (if the format has one) |

## Confidence handling
- Low-confidence regions: treat as uncertain. Don't quote them as exact values; flag and, if it matters, suggest checking the original.
- Blank / garbled stretches usually mean OCR failed on a stamp, signature, handwriting, or photo — not that the page was empty. Don't infer meaning from garbage.

## Layout
- Reconstruct structure (tables, columns, headings, form fields) — don't flatten a form into a wall of text.
- Multi-column scans often interleave; reorder into human reading order.

## Provenance
For legal / financial / medical content, say the value came from OCR and recommend verifying against the source image before anyone acts on it.
