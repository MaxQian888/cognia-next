---
"cognia-next": patch
---

Fix the system voice reading replies in the wrong language. The Web Speech utterance took its language from the microphone (STT) recognition setting, so a Chinese or Japanese reply was read by an English voice whenever STT was left on its default. The spoken language is now detected from the reply text itself. Language detection was also corrected so kanji-bearing Japanese is no longer misclassified as Chinese.
