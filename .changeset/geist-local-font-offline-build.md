---
"cognia-next": patch
---

Fix the app failing to boot with a 500 when the build machine can't reach Google Fonts. Geist and Geist Mono now load from the self-hosted `geist` package (`geist/font/sans` + `geist/font/mono`) instead of being downloaded from `fonts.gstatic.com` at build time. Offline, proxied, and CI builds — and the Tauri desktop + Capacitor mobile static exports — no longer break on a transient font-fetch failure. The exposed CSS variables are unchanged (`--font-geist-sans` / `--font-geist-mono`), so the rendered typography is identical.
