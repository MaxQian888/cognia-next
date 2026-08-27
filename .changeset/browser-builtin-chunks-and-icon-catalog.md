---
"cognia-next": patch
---

The web app no longer carries five built-in plugins and the whole icon set in
its main bundle.

Cognia Office, PDF, Documents, Presentations and Visualize are now compiled to
their own chunks (`pnpm plugin:builtin:build`, wired into `predev`/`prebuild`)
and fetched only when the plugin is actually enabled. Each chunk's SHA-256 is
recorded at build time and checked before the code is evaluated, so a chunk that
does not match the one this build produced fails to load instead of running —
these are fetched assets now, and nothing else about the delivery path proves
what they are.

Icons resolved by name — every A2UI `icon` string, context panel and workbench
panel key — now read SVG data out of a generated catalog rather than importing
`lucide-react`, which pulled all ~1.6k icon components into the bundle whether
or not any of them was ever named. Rendering is unchanged. The catalog is
committed and `pnpm lucide:check` is a registered gate, so a `lucide-react` bump
that moves it fails CI rather than silently drifting.
