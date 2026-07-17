---
"cognia-next": patch
---

Fix Chinese (and other CJK) entries in the read-aloud pronunciation dictionary never taking effect. Matching used an ASCII word boundary, which never fires around CJK characters, so a Chinese word → pronunciation mapping was silently ignored. CJK entries now match as substrings (Chinese has no spaces between words); ASCII entries keep their whole-word matching.
