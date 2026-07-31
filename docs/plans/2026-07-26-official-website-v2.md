# Cognia official website V2 — implementation plan (2026-07-26)

**Status:** accepted after a grilling pass; decisions recorded in
[ADR-0092](../content/docs/en/adr/0092-official-website-workspace.md)
**Scope:** a new `web/` workspace shipping all eight pages of the V2 website spec, bilingual,
light + dark, with build-time evidence pipelines and a re-runnable product-screenshot matrix
**Design source:**
[`docs/research/cognia-official-website-v2-design-spec-2026-07-26.md`](../research/cognia-official-website-v2-design-spec-2026-07-26.md)

## 0. Baseline facts established before planning

Verified against the repository on 2026-07-26, not assumed:

- The repository is **public**, licensed **AGPL-3.0-or-later**, 52 stars, and has **zero published
  releases and zero `v*` tags** — `release.yml` is tag-triggered and has never run.
- `.changeset/` holds **254 pending changesets**, each a full user-facing paragraph. `CHANGELOG.md`
  is a stale scaffold whose `## [Unreleased]` block still reads "Initial project setup with
  Next.js 16"; the real change history lives in `.changeset/`, not in `CHANGELOG.md`.
- `docs/` defaults to `zh` with `hideLocale: "never"`; `public/_redirects` sends `/` to `/zh/`.
- `docs/app/global.css` imports the fumadocs preset globally.
- Root Jest maps `^@/` to the repository root and does **not** ignore `docs/` or `web/`.
- `check-colocated-tests.mjs` gates `components/ hooks/ lib/` by top-level prefix; `lint-i18n.ts`
  scans `components app hooks`. Neither sees any workspace subdirectory.
- No Cognia domain string exists anywhere in the repository; origins live only in repo variables.
- The docs site references a `docsSite` i18n namespace that **does not exist** in
  `i18n/messages/{en,zh-CN}.json`. Pre-existing defect, out of scope here, tracked separately.

## 1. Non-goals

- Fixing the missing `docsSite` namespace or rewriting the stale `CHANGELOG.md`.
- Publishing the first release. The site degrades honestly without one.
- Moving the docs site's content or URLs. Only its hostname changes, at deploy time.
- Any change to the product app's components, tokens or i18n bundle.

## 2. Phase A — foundation (blocks everything)

| Step                                                                      | Verification                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| `web/` workspace: package.json, tsconfig (`@web/*`), next.config (export) | `pnpm --filter web build` produces `web/out/`  |
| Tailwind v4 `@theme` with spec §3.1 tokens + derived dark set             | Both modes render; contrast checked at AA      |
| Root wiring: pnpm-workspace, root tsconfig `exclude`, Jest `@web` mapper  | `pnpm typecheck` green; a `web/` test resolves |
| Gate wiring: colocated-test roots, changesets `ignore`                    | `pnpm audit:colocated-tests` green             |
| Site-URL resolution ladder + locale routing (`/`, `/zh/`, `/en/*` → `/`)  | Static export emits `/` and `/zh/`, not `/en/` |

## 3. Phase B — homepage cut vertically to 100%

The homepage is the proving ground for every horizontal capability. Nothing moves to Phase D
until each of these is done _on the homepage_, because a late change to any of them would
otherwise have to be applied eight times.

1. Typed `SiteCopy` contract + `en`/`zh` implementations for nav, hero, the eight sections, footer.
2. All eight sections from spec §4, in the specified order, with the single signature task.
3. Motion: fade-through, image scale, sticky task rail, each with a `prefers-reduced-motion`
   fallback that degrades the rail to a static, fully-visible stepper.
4. The three build-time pipelines (§4 below), consumed by the hero trust rail and the trust bento.
5. The screenshot pipeline (§5 below) supplying the hero and workbench visuals.
6. Co-located tests for every `web/components`, `web/lib`, `web/hooks` file.
7. Responsive rules from spec §7, accessibility rules from spec §8.

## 4. Build-time evidence pipelines

All three run before `next build`, write JSON into the build, and never run in the browser.

- **Release manifest** — reads GitHub Releases. Shape carries `hasRelease`, per-platform assets,
  version, published date. With `hasRelease: false` the download surface renders `Build from
source` + `Watch releases`. This is the _default_ path today, so it is the path that gets tested
  first, not an afterthought branch.
- **Changelog feed** — parses the 254 `.changeset/*.md` (frontmatter bump + body), takes each
  file's first commit date from git, groups by month, newest first. Once `CHANGELOG.md` carries
  real versions the feed switches to version grouping.
- **Project stats** — stars, contributors, license, all stamped with the read time and rendered
  with an explicit `as of` label.

Failure policy: a pipeline that cannot reach GitHub falls back to the last committed snapshot and
marks it stale rather than failing the build or emitting a zero.

## 5. Product screenshot pipeline

- A demo seed workspace — a fictional project, never the author's data — carrying the signature
  task's repository context, plan, failing check, diff, permission checkpoint, tests and release
  notes artifact.
- A Playwright script driving the app with a `--locale` and `--theme` parameter, producing the
  _section × {light, dark} × {en, zh}_ matrix, exported as PNG into `web/public/product/`.
  Not AVIF/WebP: `page.screenshot()` writes `png` or `jpeg` only, and an AVIF matrix would mean
  adding an image encoder to `web/`'s five-package runtime dependency set.
- Outputs are committed. The script is re-runnable but deliberately outside CI.
- Interactive step-by-step elements are **not** captured — they are DOM, per ADR-0092 §8.

## 6. Phase C — the remaining seven pages

One commit per page, reusing everything Phase B proved.

| Page                     | Content source                                                    |
| ------------------------ | ----------------------------------------------------------------- |
| `/product`               | Subsystem Map; Chat / Agents / Knowledge are anchors on this page |
| `/workflows`             | `lib/workflow/`, ADR-0011, ADR-0081                               |
| `/plugins`               | first-party plugin registry, plugin SDK capability catalog        |
| `/trust`                 | LICENSE, SECURITY, permission model, data-boundary ADRs           |
| `/download`              | release manifest + platform detection                             |
| `/use-cases/development` | dogfooding: Cognia developing Cognia, sourced from the real repo  |
| `/use-cases/research`    | reproducible script over web reader / OCR / memory / knowledge    |
| `/changelog`             | changelog feed                                                    |

Navigation: `Product` is a dropdown whose Chat / Agents / Knowledge entries are anchors into
`/product`. Footer omits Roadmap and Community entirely — spec §4.8 forbids shipping empty links.

## 7. Phase D — deployment, SEO and gates

- `deploy.yml`: a `web` target mirroring the docs job, plus a daily scheduled rebuild so the
  evidence pipelines stay fresh.
- `web/public/_redirects`: `/en/*` → `/` 301.
- sitemap, robots, canonical, reciprocal hreflang, per-page OpenGraph images pre-generated through
  the same Playwright pipeline (a static export has no `ImageResponse` runtime).
- Full gate pass: `pnpm typecheck`, `pnpm lint`, `pnpm audit:colocated-tests`,
  `pnpm test:coverage:changed -- --strict`, `pnpm --filter web build`.

## 7a. Outcome of the first execution pass (2026-07-26)

**Landed and verified.**

- `web/` workspace: Next 16 static export, `@web/*` alias, Tailwind v4 `@theme` with the spec's
  tokens plus a derived dark set, two root layouts so `<html lang>` is static per locale.
- 18 pages build (9 routes × 2 locales) — every entry in `ROUTES` has a page behind it, guarded by
  a filesystem test so the sitemap cannot advertise a 404.
- Typed bilingual copy with en/zh parity enforced by `tsc`, plus tests for the parts a type cannot
  cover: ordered collections aligned by key, anchors matching section ids, no banned phrases, no
  empty link targets.
- All three evidence pipelines run against the live repository: 52 stars, 2 contributors,
  AGPL-3.0, **0 releases**, 253 changeset entries with real commit dates.
- 18 OpenGraph images captured from the site's own tokens and typeface, in both locales.
- Gates: web typecheck clean; 42 suites / 351 tests; 21 script tests; `audit:colocated-tests` no
  new gaps; root `pnpm typecheck` exit 0; `pnpm docs:build` exit 0; `web/` lint-clean.

**Two deviations from this plan, both deliberate.**

- The changelog's _released_ branch reads the published release notes rather than parsing
  `CHANGELOG.md`. Changesets writes both from the same entries, so parsing the file would have
  meant a second Markdown parser for content already available as a string.
- `eslint.config.mjs` gained `web/.next/**`, `web/out/**` and `web/next-env.d.ts` ignores. Without
  them `pnpm lint` walked the minified export — the same reason `docs/out/**` is already listed.

**Blocked: the product screenshot matrix.**

`web/scripts/capture-product.mjs` is complete and refuses to run rather than producing a wrong
asset. It needs a dev-only seam that does not exist yet: `window.__cogniaSeedDemoWorkspace`.
`lib/dev/expose-test-globals.tsx` exposes `__cogniaSetSettings`, `__cogniaResetDb`,
`__cogniaSeedTeam`, `__cogniaSeedRun` and `__cogniaSeedWorkflow`, but nothing composes a chat
session carrying a plan, a diff, an approval checkpoint, a test result and an artifact together —
which is exactly what the signature task's screenshots show. Adding it is a product-side change
behind the existing `NEXT_PUBLIC_E2E` gate.

Until then `ProductStage` renders a labelled placeholder carrying the visual's description. That is
the designed behaviour, not a stub: the alternative is a broken image or a hand-built mock-up
presented as the product, and `product-stage.test.tsx` pins that a half-captured pair is refused
rather than shown.

## 8. Inputs still required from the maintainer

1. The apex domain string (code reads `WEB_SITE_URL`; only deployment is blocked).
2. Confirmation of the demo project's name and identity used in every screenshot.
3. Whether the screenshot pass is run here or locally by the maintainer.

## 9. Known risks

- The four-set screenshot matrix means a product UI change invalidates four sets at once. The
  capture script is the mitigation; if it rots, the site's visuals silently drift from the product.
- Two navigation/footer implementations (website and docs) stay in sync by convention only.
- The daily rebuild is the sole freshness mechanism for all evidence. Its failure must be visible,
  or the site quietly serves month-old numbers under an `as of` label that makes them look checked.
