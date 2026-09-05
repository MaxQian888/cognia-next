---
"cognia-next": minor
---

Creating a Canvas document now asks what you are making. The "+" opens a dialog with a name, a language, a starter body, and a "from a file" tab that imports through the same document parser the rest of the app uses. Before this, every entry point produced an empty Markdown document and left you to change the language afterwards from a different panel, and there was no way to open a file at all.

Text and code files import verbatim. PDF, Word, Excel, CSV, HTML, RTF, EPUB and presentations become editable Markdown, and the dialog says so, and says what did not survive, before anything is created.

The document rail's Export now goes through the shared Canvas export path. It used to write its own download with the extension and MIME hardcoded to Markdown, so a Python or SVG document saved as `.md`, a title containing a slash went into the filename unsanitised, and the download silently did nothing inside a mobile WebView.
