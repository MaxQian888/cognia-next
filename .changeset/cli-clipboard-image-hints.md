---
"cognia-next": minor
---

The CLI composer now watches the system clipboard for image content: while a pasteable image is present it shows an "image in clipboard · {chord} to paste" hint under the input using the configured `pasteImage` keybinding, and once images are attached it shows "N attached · /images to manage". A new `/images` command (alias `/attachments`, chord `Ctrl+X Ctrl+I`) opens an attachment manager that lists each `[Image N]` placeholder with its resolved path, marks missing files, opens an image on Enter, and removes one (`d`/Backspace) or all (`c`) placeholders through a single undoable edit.
