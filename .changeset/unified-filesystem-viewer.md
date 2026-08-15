---
"cognia-next": minor
---

File previews are now one thing everywhere. The terminal's read-only viewer, the project editor's Preview tab, and file references in chat, stack traces and log details all go through the same matcher, loader and renderers, so Markdown, HTML and JSON look the same wherever you open them and a text file always falls back to a read-only editor that can jump to a line. Three user-visible consequences: opening a file reference now works when the terminal panel is closed (it previously did nothing at all); files are read only from inside the workspaces you have open, so a stack frame pointing somewhere like `/usr/lib` now says so instead of opening; and HTML previews no longer allow pop-ups, modal dialogs, form submission or outbound network requests — scripts still run in your own project files, but not in HTML opened from a terminal link. Previews are capped at 2 MB, and the project Preview tab still shows your unsaved buffer rather than the file on disk.
