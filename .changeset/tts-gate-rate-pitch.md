---
"cognia-next": patch
---

Hide the Rate and Pitch sliders for cloud voice providers, where they did nothing. Those two controls only affect the built-in system (browser) voice; cloud providers use their own speed setting in their provider config, so dragging Rate or Pitch for, say, OpenAI silently had no effect. They now show only for the system voice. Volume — the one universally-applied control — stays for every provider.
