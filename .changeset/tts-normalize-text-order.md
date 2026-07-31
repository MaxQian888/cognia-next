---
"cognia-next": patch
---

Fix spoken read-aloud text mangling markdown. The TTS text normalizer previously collapsed newlines and substituted symbols before stripping structure, so headings were read as "number …", fenced code blocks were spoken verbatim, and list markers ("-", "1.") were read out. Structure is now stripped first (code fences, inline code, headings, lists, emphasis, links, URLs) before whitespace collapse and symbol substitution, so read-aloud narrates clean prose.
