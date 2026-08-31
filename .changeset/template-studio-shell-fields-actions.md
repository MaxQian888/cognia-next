---
"cognia-next": minor
---

Template Studio: the shell, the fields and the package actions it was missing.

The Studio renders inside the shared feature shell, so /templates gets the wallpaper marker it never had, persisted panel sizes, and an inspector rail that a card tap opens on a narrow viewport. A phone gets its own catalogue view instead of the desktop authoring workspace: find a template, fill its inputs through the same typed controls, preflight, instantiate.

A draft can now be given the eight fields its definition has always carried. Tags, category, author, icon and localized names travel with it, and dependencies, capabilities and compatibility reach the three preflight gates that were unreachable from the only surface that can author a template: the platform blocker, the host version range and the required-dependency check.

The Packages tab does something. Verify re-resolves publisher trust and re-hashes each stored release, saying plainly that the signature itself cannot be re-checked without the original bytes. A package can be yanked, unyanked, re-exported (unsigned, because the private key never entered the app) or removed, with removal asking first and leaving anything already built from it rebindable rather than mysterious. Migration rollback sits under it behind its own confirmation.

Export opens a picker: a package accepts 256 definitions and a description, and the button used to build a nameless single-release one. An instance that lost its source can be rebound to another release of its own domain, a release can be yanked and not only deprecated, and a draft can finally be deleted.
