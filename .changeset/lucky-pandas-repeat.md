---
"cognia-next": minor
---

Loading indicators now survive "reduce motion" instead of freezing. The global reduce-motion guard collapsed every animation to a single 1ms iteration, which turned all ~220 spinners into static, broken-looking glyphs and every skeleton into an inert grey block — reduced-motion users lost all evidence the app was still working. Motion is now tiered: decoration is still suppressed, status feedback (spinners, skeleton pulses) keeps running at the user's chosen speed, and the movement-heavy classes degrade to a fade instead of translating or scaling.

Screen-reader support for loading states was reworked at the same time. Skeletons are decorative and no longer silent-but-present, spinners stopped firing a redundant untranslated "Loading" announcement from inside already-labelled buttons, and a new `LoadingRegion` emits exactly one polite announcement per loading area — re-announcing only when a long wait escalates, or when the device turns out to be offline.

New loading areas also stop flickering: an indicator no longer appears at all for the sub-frame local reads that make up most of the app, and once shown it can no longer strobe away.
