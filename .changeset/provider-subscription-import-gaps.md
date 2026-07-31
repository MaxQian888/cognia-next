---
"cognia-next": patch
---

Close functional gaps and align motion/layout across provider settings, subscription, and the import dialogs.

Fixes: desktop-only settings sections (Subscription, CCSwitch, and 19 others) are no longer reachable in web mode via ⌘K or a `?section=` deep link, so the browser can't walk a Claude sign-in flow that could only fail at the final keychain call; plugin import now shows the permissions and capabilities a manifest declares before you accept it; saved subscription accounts show their credential expiry; a "limited" connection test now resolves its headline copy (it rendered a raw i18n key) and says plainly that no authoritative request was made; per-domain data import previews per-table row counts before applying.

Polish: provider settings crossfades between providers, its loading skeleton matches the real two-column layout, wide screens no longer stretch the forms edge to edge, and model rows reserve space for metadata that arrives late; the quota bar is now one component so it animates at one speed everywhere; quota percentages count up in step with their bar; the subscription overview distinguishes "still loading" from "no data"; and the Codex/OpenCode panels explain an unqueryable quota before showing the empty gauge.
