---
"cognia-next": patch
---

An external agent's "recommended actions" now appear in your language. The readiness panel told you what to do about a missing CLI — install this, set an absolute path, prefer WSL2 on Windows — and said it in English regardless of the language the rest of the panel was in, because those sentences were assembled in code rather than looked up in the message catalogue.

The advice this app generates is now a message reference, resolved at render time like the recovery hints beside it. Advice that arrives some other way is left alone: a line saved by an older build, or supplied by a third-party agent preset, is shown exactly as it was written, because there is no translation to look it up by and dropping it would throw away the only guidance such a preset offers.

Nothing needs migrating and no configuration changes. Existing saved agents keep whatever they had; new advice generated from this release forward is translated.
