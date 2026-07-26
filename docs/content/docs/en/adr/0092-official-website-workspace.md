---
title: "0092 — Official Website Workspace and Three-Site Topology"
description: "A dedicated web/ static-export workspace for the marketing site, split from the fumadocs docs site, with build-time evidence pipelines, a re-runnable product-screenshot matrix, and English-first bilingual routing."
---

# ADR 0092 — Official Website Workspace and Three-Site Topology

- **Status:** Accepted
- **Date:** 2026-07-26
- **Builds on:** ADR-0059 (static docs export on Cloudflare Pages)
- **Design source:** `docs/research/cognia-official-website-v2-design-spec-2026-07-26.md`
- **Plan record:** `docs/plans/2026-07-26-official-website-v2.md`

## Context

The repository shipped a product shell and a documentation site but never had a marketing site.
The V2 website spec asks for something neither existing surface can host:

- a bespoke visual system (`paper` / `ink` / `graphite` reading-vs-execution layers, Geist,
  hairline rules) that is deliberately *not* the product's token set and *not* the fumadocs theme;
- English-first positioning aimed at an open-source developer audience, with the homepage served
  from the site root for search;
- every outward claim bound to a verifiable source — license, releases, supported OS, provider
  registry, permission behaviour — with no hand-maintained numbers.

Three properties of the existing docs site make it a poor host for that:

1. **Locale root is already spent.** `docs/lib/i18n.ts` sets `defaultLanguage: "zh"` with
   `hideLocale: "never"`, and `docs/public/_redirects` sends `/` to `/zh/`; `app/[lang]/page.tsx`
   then redirects to `/docs`. A marketing homepage needs `/` to return content, not two hops.
2. **The theme is global.** `docs/app/global.css` imports `fumadocs-ui/css/preset.css` at the app
   level. Marketing routes in the same app inherit a second, competing base layer.
3. **The build is heavy.** MDX collections, Orama indexing and Mermaid are on the docs critical
   path; website iteration should not pay for them.

The product app is not a candidate at all: its `out/` export is consumed by Tauri and Capacitor,
so anything added there ships inside the desktop and mobile binaries.

## Decision

### 1. Three sites, three workspaces

| Site        | Workspace | Output       | Hosting                       |
| ----------- | --------- | ------------ | ----------------------------- |
| Product app | `/`       | `out/`       | Tauri desktop + Capacitor     |
| Docs        | `docs/`   | `docs/out/`  | Cloudflare Pages              |
| Website     | `web/`    | `web/out/`   | Cloudflare Pages (new project)|

`web/` is a Next.js 16 `output: "export"` workspace with its own `package.json`, `tsconfig.json`,
PostCSS and Tailwind v4 setup. It has **zero cross-package imports** — it does not reach into the
product's `components/ui/`, `lib/`, or the shared `i18n/messages` bundle. The marketing surface is
static presentational code with no overlap with product components, and importing them would drag
Zustand / Dexie / Tauri dependency graphs into a brochure.

### 2. Domain split, injected not hardcoded

The website takes the apex domain (`www` redirects to apex); the docs site moves to the `docs.`
subdomain. Neither origin is written into source: the website resolves absolute URLs
(canonical, hreflang, OpenGraph, sitemap) from `NEXT_PUBLIC_WEB_SITE_URL`, falling back to
Cloudflare's `CF_PAGES_URL`, then to the dev origin — the same resolution ladder `docs/lib/site.ts`
already uses. Cross-site links (the `Docs` nav entry) read `NEXT_PUBLIC_DOCS_SITE_URL`.

### 3. `@web/*`, never `@/`

The root Jest config maps `^@/(.*)$` to `<rootDir>/$1` — the repository root — while a workspace
`tsconfig.json` maps `@/*` to its own directory. Root Jest collects `docs/**` and `web/**` test
files (neither is in `testPathIgnorePatterns`), so the two mappings collide. The docs site only
survives this because its tests happen to use relative imports; that is luck, not design.

`web/` therefore uses the `@web/*` prefix, mapped in `web/tsconfig.json` and in the root Jest
`moduleNameMapper` (`^@web/(.*)$` → `<rootDir>/web/$1`). The root `tsconfig.json` adds `web` to
`exclude` so the product typecheck does not compile it under the product's `paths`.

### 4. English-first bilingual routing

`/` serves English content directly — no redirect — and `/zh/…` serves Chinese, with reciprocal
`hreflang`. `/en/*` is a 301 to `/` so the default locale has exactly one canonical form. Because a
static export has no middleware, every locale path is generated at build time and
`web/public/_redirects` carries the `/en/*` rule on Pages.

### 5. Copy is typed content, not an ICU bundle

Website copy lives in `web/content/` as a `SiteCopy` interface with `en` and `zh` implementations.
Rationale:

- marketing copy is structured (bullet arrays, a run-strategy table, a three-column footer), which
  `next-intl` can only express through `t.raw()` with the types discarded;
- missing or extra keys in either locale fail `pnpm typecheck`, which is a stronger parity gate
  than `lint:i18n` — that gate scans only the root `components/ app/ hooks/` and would never see
  `web/`;
- the product's `i18n/messages/*.json` is bundled into the Tauri and Capacitor artifacts, so
  marketing strings must not live there.

This satisfies the intent of the repository's i18n rule — no user-facing string is hardcoded in a
`.tsx` file — through a mechanism suited to the content shape.

### 6. Evidence is resolved at build time

A static export has no request-time runtime, so every dynamic claim is materialised during the
build and stamped with the time it was read:

| Claim                          | Pipeline                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| Latest release, supported OS   | GitHub Releases API → static release manifest                    |
| Changelog (unreleased)         | `.changeset/*.md` + each file's first commit date → grouped feed |
| Changelog (released)           | the published release notes, which carry the same aggregated text |
| Stars, contributors            | GitHub API → stats file rendered with an `as of <date>` label    |

A scheduled daily rebuild keeps them fresh. No client-side GitHub calls: unauthenticated API is
60 requests/hour/IP, and a visitor-side call leaks visitor IPs to a third party for a number that
changes weekly.

### 7. Degrade to the truth, never to a dead link

The repository currently has **zero published releases** — `release.yml` is tag-triggered on `v*`
and has never run. The download surface therefore renders from the release manifest's actual
state: with no release it offers `Build from source` and `Watch releases`; once a release exists
the same component resolves to `Download for macOS / Windows / Linux`. The same rule governs the
changelog (`.changeset` feed until `CHANGELOG.md` carries real versions) and the footer, which
omits Roadmap and Community entirely until those surfaces exist.

### 8. Product visuals: real screenshots plus DOM reconstructions

Large product visuals are real screenshots captured by a re-runnable Playwright script driving the
app against a **purpose-built demo seed workspace** — never the author's working data, which would
publish repository names, conversation contents and provider configuration. The capture matrix is
*section × {light, dark} × {en, zh}*, and outputs are committed under `web/public/product/`; the
script is not part of CI because a Playwright pass is too heavy and too brittle for the site build.

Step-by-step interactive elements — the signature task rail, the stepper, the permission
checkpoint — are reconstructed in DOM rather than captured, because the spec requires them to be
translatable, keyboard-operable, and to collapse to a static stepper under
`prefers-reduced-motion`. A bitmap can do none of those.

#### Amendment, 2026-07-26 — a reconstruction is the fallback, not an empty frame

As shipped, the capture matrix is empty: it needs a product-side seed seam
(`window.__cogniaSeedDemoWorkspace`) that does not exist yet, so `product-shots.json` has no cells.
The original rule left `ProductStage` rendering a frame containing one sentence of alt text, which
in practice meant the **largest visual on every page was blank** — the hero's near-full-width stage
was an empty box roughly a screen tall.

The preference order is therefore now explicit, and the second entry is new:

1. a real capture, whenever the matrix holds *both* themes for that section;
2. otherwise a **DOM reconstruction of the same surface, permanently labelled as one**.

This is a deliberate narrowing of "large product visuals are real screenshots". What §8 exists to
forbid is a hand-built mock-up passed off as a photograph of the application, and that is addressed
directly rather than by leaving the page empty: `AppFrame` takes a required `label` prop, so no
reconstruction can render without its marker in the title bar, and `ProductStage` additionally
prints the "not a screenshot" note in the figure caption. A capture, when one exists, still wins.

Two consequences worth stating, because they are not obvious:

- **Reconstructions are `aria-hidden` behind one `role="img"` and the section's alt text.** The
  depicted rail entries and tab strips are pictures of controls; announcing them would offer a
  screen-reader user a dozen affordances that are not there. A screenshot gives assistive
  technology its alt text, so a stand-in for a screenshot gives the same. The signature demo's step
  artifacts are the deliberate opposite — real content, in the tree, translated — which is the
  reason the paragraph above has them as DOM in the first place.
- **The demo identity lives in `web/content/demo-task.ts`**, matching the capture script's `DEMO`,
  and a test pins the two together. A reconstruction and a future screenshot of the same section
  have to describe the same task, or the site tells two stories about one release.

Nothing here reduces the value of running the capture. It remains the goal; this is what the page
does until then, instead of shipping a blank stage.

### 9. One signature task across the whole site

Every page advances the same task — *"Review this release, fix the failing check, and prepare the
launch notes"* — enacted in the demo project. No page substitutes a different scenario. Use-case
pages are the one deliberate exception: they narrate reproducible end-to-end scripts, and the
development page uses dogfooding (Cognia developing Cognia), explicitly layered as such.

### 10. Dark mode derives from the graphite stage

The spec defines only light values. Dark mode reuses the *same semantic token names* with `ink`
promoted to the page substrate, `graphite` to panels, and `action` / `approval` held at their hue
but lifted to WCAG AA against the dark substrate. There is no second brand palette, and the
light-reading / dark-execution contrast is preserved inside each mode.

### 11. Gate coverage

- `scripts/gates/check-colocated-tests.mjs` gains `web/components/`, `web/lib/`, `web/hooks/` in
  `TS_ROOTS` — the same three roots it gates in the product tree. `web/app/` follows the product's
  `app/` precedent (tests written, not gated); `web/content/` is data whose parity `tsc` already
  proves.
- `.changeset/config.json` adds `web` to `ignore`: the website is not part of the `cognia-next`
  application version, and shipping it is not a change desktop users perceive.
- `eslint.config.mjs` ignores `web/.next/**`, `web/out/**` and `web/next-env.d.ts`. Flat config does
  not read `.gitignore`, so without these `pnpm lint` walks the minified export — the same reason
  `docs/out/**` is already listed.
- `deploy.yml` gains a `web` target plus `CF_WEB_PAGES_PROJECT` / `WEB_SITE_URL` variables. The
  daily evidence rebuild is a separate `refresh-website.yml` that *calls* `deploy.yml`: on a
  scheduled run `inputs` is empty, and every existing job gates on `inputs.target`, so adding the
  trigger in place would have meant rewriting those expressions on jobs that deploy Workers and Fly
  apps.

## Consequences

**Positive.** The website can iterate without rebuilding MDX collections or touching documented
docs URLs. Its visual system is free of the fumadocs base layer. Every outward number has a
pipeline and a timestamp instead of a maintainer's memory. The `@web/*` alias closes a latent
module-resolution collision that the docs workspace is currently one refactor away from hitting.

**Negative.** Two Cloudflare Pages projects and two navigation/footer implementations must be kept
in sync by convention rather than by shared code. Cross-site links are external links. The
screenshot matrix is four sets, so a product UI change that invalidates the visuals is a
four-set re-capture.

**Risks.** The demo seed workspace must stay faithful to the shipping product or the screenshots
become a slow-motion lie; the capture script is the mitigation, not the seed data itself. The
daily rebuild is the only thing keeping the evidence pipelines from going stale, so its failure
must be visible.

## Alternatives rejected

- **Marketing routes inside `docs/`.** Requires reworking the docs locale root and demoting the
  fumadocs preset from a global import to a route-scoped one, and binds the website's release
  cadence to the documentation build.
- **A Worker fronting one domain over two Pages projects.** Buys a single origin at the cost of a
  routing layer that must be maintained, previewed and cache-tuned.
- **Marketing pages in the product app.** Ships brochure code inside the Tauri and Capacitor
  bundles.
- **Reusing the product's dark tokens.** They are zero-chroma neutrals tuned for dense UI; the
  spec's stage is deliberately cool-toned, and neutrals flatten on a large-whitespace page.
