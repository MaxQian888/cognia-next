# PWA icons

Wave 4 / ADR-0026 — referenced by `app/manifest.ts` and the Web App Manifest.

## Current state

`icon.svg` and `icon-maskable.svg` are placeholder vector marks (sized
512×512, monochrome) that satisfy the manifest schema and let the Serwist
SW build without errors. They render correctly on modern browsers (Chrome
93+, Safari 16.4+) which accept SVG icons in the PWA manifest.

## Production icons (TODO)

For Android adaptive icons + iOS Touch Icon optimization, replace with:

- `icon-192.png` — 192×192, transparent corners OK
- `icon-512.png` — 512×512, transparent corners OK
- `icon-512-maskable.png` — 512×512, solid background (safe zone is the inner ~80%)
- `apple-touch-icon.png` — 180×180, opaque background

Update `app/manifest.ts` to reference the PNG variants and add the Apple
Touch Icon as `<link rel="apple-touch-icon">` via the Metadata API in
`app/layout.tsx`.

## Source files

Vector sources live in this directory; SVG → PNG export is done via
`scripts/export-icons.mjs` (TODO) using `sharp` or `resvg`.
