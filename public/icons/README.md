# PWA icons

Wave 4 / ADR-0026 — referenced by `app/manifest.ts` and the Web App Manifest.

## Current state

Production PNG icons rasterised from `mobile/resources/splash.png` — the
single source shared with the desktop (`src-tauri/icons/`) and Android
(`mobile/android/.../mipmap-*`) icon sets:

- `icon-192.png` — 192×192, standard purpose
- `icon-512.png` — 512×512, standard purpose
- `icon-512-maskable.png` — 512×512, maskable (the splash has an opaque
  near-black border, so it satisfies the maskable safe-zone requirement)

The Apple Touch Icon (`app/apple-icon.png`, 180×180) and favicon
(`app/favicon.ico`) are served via the Next.js file conventions, so no
`<link>` wiring is needed in `app/layout.tsx`.

## Regenerating

All icon sets are produced from the one source by the Tauri CLI (it bundles
its own image processing — no `sharp`/`resvg` needed):

```bash
# Desktop set + Android mipmaps (under src-tauri/icons/android, then copied
# into the Capacitor project) + iOS appiconset:
pnpm tauri icon mobile/resources/splash.png

# Web PNG sizes for this directory + the Apple Touch Icon:
pnpm tauri icon mobile/resources/splash.png -p 192 -p 512 -p 180
```
