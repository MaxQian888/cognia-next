---
"cognia-next": patch
---

Job Center: stop polling the machine while nobody is looking. The panel lives in the status bar (and the mobile shell), so it is mounted for the whole life of the app, but it ran a one-second clock and hit the native job supervisor twice every two seconds regardless of whether its sheet was open or anything was actually running. The clock now ticks only while the sheet is open and something is live, and the supervisor falls back to a slow heartbeat when the sheet is shut — it still cannot stop entirely, because the trigger's badge counts those rows. Opening the panel reseeds the clock and refreshes immediately, so the first elapsed reading is correct.
