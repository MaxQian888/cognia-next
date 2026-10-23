# Cloud-document P0 native fixture

A standalone page that runs the production remote-document search, staging,
attachment intake, preparation and proxy fetch against in-memory document
accounts, for native (Tauri) acceptance of the cloud-document P0 boundaries.
See `docs/reports/2026-10-22-cloud-documents-p0-boundaries.md`.

- `entry.tsx` is the harness page.
- `build.mjs` bundles it with esbuild, replacing the provider registry and the
  host-only modules with the stubs in `fixtureModules()`.

```bash
node scripts/smoke/fixtures/cloud-docs-p0/build.mjs --public --force
```

`--public` writes `public/.p0-native-fixture/` so `pnpm dev` serves it at
`http://localhost:3000/.p0-native-fixture/`. That path is gitignored; delete it
after the run, because everything under `public/` ships in the static export.
Without `--public` the page is written to `.cache/cloud-docs-p0/ui-fixture/public/`.
