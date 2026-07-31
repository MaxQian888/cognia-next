---
name: next-best-practices
description: >-
  Apply Cognia's Next.js App Router conventions. Use when creating or reviewing
  routes, layouts, client/server boundaries, metadata, images, fonts, async
  APIs, hydration, Suspense, or bundling in the main static-export app or the
  separate Fumadocs server app.
---

# Next.js Best Practices for Cognia

Read `package.json`, `next.config.ts`, and the target package before applying
generic Next.js guidance. The repository has two different deployment models:

- Main app: Next.js 16 static export (`out/`) consumed by web, Tauri, and Capacitor.
- `docs/`: Fumadocs server build, deployed separately.

## Main-app invariants

1. **Keep routes statically exportable.** Use static route files plus query
   parameters for runtime IDs. Do not add `app/api`, Route Handlers, Server
   Actions, runtime cookies/headers, ISR, or request-time server data.
2. **Put privileged work behind existing seams.** Desktop operations belong in
   Tauri commands/sidecars; browser/mobile use their existing client or service
   paths. A Node-only library must not enter the client bundle.
3. **Keep server components serializable.** Add `"use client"` at the smallest
   interactive boundary; pass serializable props and avoid async client
   components. Guard browser APIs during prerender.
4. **Respect build configuration.** Inspect `next.config.ts` before changing
   image, font, service-worker, alias, or transpilation behavior. Cognia uses
   local fonts and static-export-specific image settings.
5. **Preserve shell parity.** Check web, Tauri, and Capacitor assumptions for
   navigation, safe areas, storage, and browser APIs.

## Reference routing

Load only the relevant generic reference, then apply the invariants above:

- routes/files: `file-conventions.md`, `parallel-routes.md`
- boundaries/async: `rsc-boundaries.md`, `async-patterns.md`, `directives.md`
- client data/hydration: `data-patterns.md`, `hydration-error.md`, `suspense-boundaries.md`
- metadata/assets: `metadata.md`, `image.md`, `font.md`, `scripts.md`
- bundling: `bundling.md`
- errors: `error-handling.md`

`route-handlers.md`, `runtime-selection.md`, and `self-hosting.md` apply to the
docs package or an explicitly separate service, not the main app.

## Verification

Run focused tests, `rtk pnpm typecheck`, `rtk pnpm lint`, and
`rtk pnpm build`. For new routes or Node-ish imports, run the
`static-export-auditor` before completion.
