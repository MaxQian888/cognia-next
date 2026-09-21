---
"cognia-next": minor
---

GitHub marketplace catalogs can now declare `presets` — named bundles of plugins (`{name, description, plugins: [catalog plugin names]}`, the Aiden/Claude marketplace convention). Resolved presets surface as "Bundle" cards above the grid in the Workspace section and the merged "all" view; installing a bundle runs each member through the existing per-plugin pre-install consent chain sequentially, in declared order, skipping already-installed members and continuing past failures. Catalog entries the preset names but no plugin carries are shown as missing rather than silently dropped, and a user cancel stops the bundle with every member accounted for (installed / skipped / failed / cancelled).

Verified: `pnpm test` (`lib/plugin/package/github-marketplace.test.ts`, `lib/plugin/marketplace/preset-install.test.ts`, `components/plugins/marketplace/plugin-marketplace-preset-card.test.tsx`, full `components/plugins/marketplace/` + `hooks/plugins/` — 34 suites), `pnpm typecheck`, `pnpm lint:i18n`.
