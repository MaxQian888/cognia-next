---
"cognia-next": minor
---

Templates are now one system instead of twelve (ADR-0100). Agent teams, workflows, subagents, custom modes, characters and skills — plus Mini Apps, goals, scheduled tasks, prompt presets, subscription presets and documents — are searchable together in the new Template Studio at `/templates`, filterable by kind, status and how much the source is trusted.

Templates now have versions and a content hash, so a template can be published as an immutable release, forked, deprecated, and shared as a `.cognia-template` package that is size-bounded, checksummed and Ed25519-verified on import. Applying one shows a plan first — what it will create, what it needs to bind to, and what is blocking it — and the resulting resources remember which template and version they came from, so you can later see what drifted, update to a newer release, or detach them for good.

Plugins can contribute templates through a dedicated API with its own four permissions, and instantiating one asks you first; a plugin never sees the ids of the resources its template binds to, and cannot apply a plan it did not have checked.

Your existing built-in and saved templates are converted on first launch. The conversion is journaled per device, so it is safe to re-run and can be rolled back per kind, and shipped built-ins keep tracking the app version rather than freezing at whatever shipped when you first launched.
