---
"cognia-next": patch
---

A plugin naming an icon lucide has since renamed now installs and draws. Lucide has two name spaces — the canonical icon names its `icons` record is keyed by, and the names the package exports, which is where its own renames survive as aliases. Manifest validation and every render site consulted only the first, so `history` (renamed to `rotate-ccw-clock`, still exported as `History`) was refused as "must name an exported lucide-react icon" even though importing it works — and the same held for any other icon lucide renames from here on. Both spellings are accepted now, and the kebab-case form the retired `PLUGIN_CONTEXT_PANEL_ICONS` allowlist published resolves through the same path, so a context panel pinned to `"file-text"` draws instead of validating and then coming back blank.
