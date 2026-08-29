---
"cognia-next": patch
---

Settings: two panels that went blank instead of showing an empty list.

- **Project environments** reads its rows straight off the local database with no schema validation, and the shape itself records that older definitions omit fields. A row saved before `variables`, `keyringReferences` or `actions` existed threw while the panel was rendering, so the whole section disappeared — and re-saving such a row failed its own validation. Rows are now filled in on read, which also covers the executor and the resolver.
- **External agents** assumed every quick-start preset carries command arguments and tags. Both are optional, and a plugin can register a preset at runtime, so one that omitted either blanked the section — the preset gallery included, before you clicked anything.

A new guard fails any settings file that reaches through an optional value into an array it assumes exists.
