---
"cognia-next": patch
---

Surface two boot failures that were previously invisible. When Cognia can't read your saved settings it now shows a persistent banner explaining that the session is running on defaults, with a retry — instead of silently behaving like a fresh install with no provider, no API key and a reset theme. When a database schema upgrade stays blocked because another window (desktop pet, fleet island, a second tab) is holding the old version open, a dialog now names the problem and offers a reload, instead of leaving the app frozen on the loading spinner with only a console message.
