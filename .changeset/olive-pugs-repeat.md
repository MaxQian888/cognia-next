---
"cognia-next": minor
---

Rebuild the `/pair` screen and make every pairing failure actionable. The browser flow now lays out in two columns at desktop width instead of a phone-width column that grew a scrollbar as soon as an invitation was pasted, and each failure is classified into a named cause with numbered remedies that quote this Host's URL and this tab's own origin — replacing the single line "Pairing failed / Failed to fetch" that stood for fourteen different problems. A `no-cors` probe now separates "the Host refused this browser origin" from "nothing is listening there", a locked local account is reported as such instead of as a storage failure, and the panel says when an invitation has already been spent so retrying cannot work.
