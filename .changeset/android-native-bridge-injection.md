---
"cognia-next": patch
---

Android: the native bridge now loads. Capacitor was injecting everything under the app's `/plugins` folder (page data and theme images) into its startup script as JavaScript, so the script failed and the app ran as a plain browser: no clipboard, sharing, file export, microphone or notification permissions, the device shown as "Linux browser", and desktop-only sync errors. Enabling push on a build without Firebase no longer crashes the app, and an account created while the bridge was broken now gets its unlock screen instead of an app where every message fails.
