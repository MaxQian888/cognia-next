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
