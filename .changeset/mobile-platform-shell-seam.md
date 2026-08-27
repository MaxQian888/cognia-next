---
"cognia-next": patch
---

Split the root layout's shell wiring behind a build-target seam so the Capacitor app stops shipping the desktop chrome it can never run. `components/runtime/platform-shell.tsx`, `platform-desktop-sources.tsx` and `platform-desktop-initializers.tsx` are what `app/layout.tsx` mounts; a `.mobile.tsx` variant beside each is compiled instead on the `NEXT_PUBLIC_PLATFORM=mobile` build, selected by a platform extension prepended to webpack's `resolve.extensions` (the React Native / metro convention). The phone bundle now drops the title bar, guild rail, status bar, command palette, terminal dock and extension-host bar, plus the Tauri companion bridges and every desktop boot-initializer chunk — all of them code that self-gated to a no-op there.

Web and Tauri deliberately share one variant, because they share one `out/`: `tauri.conf.json` points `frontendDist` at the same static export the browser build produces, and `pnpm tauri dev` serves it through plain `pnpm dev`. Anything compiled out for the web would be missing on the desktop, so the web/desktop split stays where it has always been — runtime gates on `usePlatform()` / `isTauri()`. The mobile shell wrapper stays in the shared variant for the same reason `tests/e2e/mobile/**` needs it: those specs run against the web build and fake Capacitor at runtime.
