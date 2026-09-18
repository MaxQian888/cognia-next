---
"cognia-next": minor
---

Lighter tool-call rendering in the message stream: Read/Write/Edit/Grep/Glob/LS/NotebookEdit calls now render as compact inline rows (status dot + verb + file-type icon + path + result meta) that expand into their payload — matching the Bash row treatment. File paths use the shared `FileTypeIcon` system (plugin icon themes on desktop, built-in glyphs elsewhere). Code blocks gain a `compact` density (slim header, tight padding, smaller code type) used by the file-tool expansions, so payloads no longer read as loose cards inside the row. The block header also accepts a `headerTitle` — Read/Write/NotebookEdit payloads put the file's basename workbench link there instead of restating the full path on its own line, so the file identity is stated once by the row and once by the header rather than three times. Tool activity groups use the same borderless row chrome in every display mode, and artifact cards get a slim single-line header.
