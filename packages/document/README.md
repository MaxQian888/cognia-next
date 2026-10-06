# @cognia/document

Cognia's "read file" layer. Folds eleven mainstream document formats (PDF,
Office, EPUB, HTML, Markdown, RTF, CSV, code, presentation, OpenDocument) into a
single `ProcessedDocument`: raw text + embeddable text + structured metadata +
parse diagnostics.

Framework-agnostic. Heavy parsers (`pdfjs-dist`, `mammoth`, `xlsx`, `jszip`,
`cheerio`) are dynamically imported and declared as peer dependencies so they
stay out of the mobile bundle unless actually used.

```ts
import { processDocument } from "@cognia/document/document-processor"
import { detectDocumentType } from "@cognia/document/support-matrix"
```

Consumed in dev/test from source (`packages/document/src`).

### Canonical document navigation

`ProcessedDocument.content` is original extracted source text. `embeddableContent`
is a distinct embedding projection and must not replace it in persisted sources.
`structure` contains a versioned chapter tree and page ranges over `content`:
UTF-16 character ranges are half-open; line and page numbers are 1-based and
inclusive. `contentHash` identifies the extracted text version, independently
of any binary source fingerprint. Section IDs derive from parent/title paths
and repeated-heading occurrences, so body-only edits retain section identity.
Optional summaries are navigation aids; readers answer from original slices.

`buildTextDocumentStructure` backfills text documents through the existing
Markdown parser. PDF processing extracts bookmarks by default (override with
`extractPdfOutline: false`) while retaining native spatial extraction where
available. Unresolved bookmarks fall back to page navigation. Named PDF
destinations and indirect page references are resolved by pdfjs, rather than
assuming PDF object numbers are page numbers. OCR remains in the application
OCR router, which publishes fresh canonical ranges when page text changes.

`DocumentSnapshot<Format>` is the shared parsed-text/tree envelope for activated
index generations. Twin stores its current snapshot on the existing source
row in the same transaction as chunk replacement and pointer activation;
failed replacements preserve it, and deleting the source removes it. Empty
replacements activate an empty generation and retire prior chunks/vectors.
Twin has no retained-revision rollback API; Knowledge Base owns its separate
revision history and authorization semantics.
