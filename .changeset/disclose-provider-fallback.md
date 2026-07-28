---
"cognia-next": patch
---

When a turn fails and Cognia retries it against a different provider, the disclosure is now honest and localized. It previously announced the swap in English only, and announced it _before_ the retry was issued — so a retry that then failed had already told you it was running somewhere else. The notice now fires once the substitute turn is genuinely in flight, and reads in your own language.
