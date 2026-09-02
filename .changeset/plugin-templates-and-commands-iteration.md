---
"cognia-next": minor
---

Plugins can iterate the templates they own (`ctx.templates` save, publish, fork, deprecate, delete, export, import) and register slash commands or edit custom `.md` commands at runtime through the new `ctx.commands`, behind `commands:read` / `commands:write`. Custom commands in `.cognia/commands` are scanned on the desktop, and project-scope commands can be authored from a paired browser or phone.
