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

## Amendment, 2026-08-01 — one canvas moment, one pinned section, and a re-drawn-chrome exception

Three narrow exceptions, each recorded here so none becomes a precedent by accident. The
supporting measurements are in
`docs/research/cognia-official-website-motion-craft-2026-08-01.md`.

### A. Exactly one canvas surface, and it is the provenance rail

The design spec §6 allows the site two motion languages (cinematic fade-through, image scale) plus
the sticky task rail. That budget stands. It gains **one** named exception: the provenance rail in
the Trust section — the site's only second-read moment under spec §2.4 — may render its
Source → Action → Permission → Result thread on a `<canvas>` as a signal that travels the path and
**stops at the Permission node**, which is the same narrative beat as the hero halting at
`Waiting for approval` (spec §6.1).

The boundaries are the point:

- **One surface, site-wide.** A second canvas is a spec change, not a judgement call.
- **Below the fold**, so spec §8's "no above-the-fold WebGL" is untouched.
- **`--action` only**, inside spec §3.1's ≤5% cyan budget. No new colour, no gradient.
- **Canvas 2D, not WebGL/three**, unless a later decision says otherwise in writing. `three` +
  `@react-three/fiber` + `drei` is ~43 MB on disk against `motion`'s 772 KB, and the repository has
  no `three` Jest mock — the product's one 3D component mocks it locally in its own suite.
- **Three fallbacks, all to the same static `<ol>` that ships today**: `prefers-reduced-motion`, no
  2D context, and the static-export first paint (the DOM renders first; the canvas layers on after
  mount, because a static export has no SSR fallback path).
- **The canvas is `aria-hidden`**; the `<ol>` keeps the semantics. This is the §8 amendment's
  "visual layer hidden, semantic layer intact" rule applied to a second surface.

The reduced-motion fallback is not optional politeness. The belt in `web/app/globals.css` collapses
`animation-duration` and `transition-duration`; it has no effect on a `requestAnimationFrame` loop.
Any continuous motion added to this site must gate itself on `useReducedMotion()`, exactly as
`Hairline` and `Reveal` already do.

This applies to `requestAnimationFrame` work specifically. It is *not* a general hole in the belt:
`scroll-behavior`, for instance, is explicitly covered — `globals.css` sets it back to `auto` on
both `html` and `*` under `prefers-reduced-motion: reduce`. The belt's blind spot is the JS
animation loop, and only that.

### B. Exactly one scroll-pinned section, and it never intercepts scrolling

The signature demo (`#task`) may hold the viewport while the reader's own scrolling advances its
six steps, then release. This is spec §6.6, and it is the scroll-driven form of the sticky task
rail §6.3 already describes — the same six states in the same order, with the pacing handed back to
the reader instead of run on a 2600ms timer.

The constraint that matters most is *how*: a tall wrapper with a `position: sticky` child, where
the code only **reads** the scroll position the page already has. Nothing listens for `wheel` or
`touchmove`. Taking over the wheel would break scroll speed, momentum, keyboard paging,
find-in-page and scrollbar dragging all at once, and would leave a reader who wants past the
section with no way through. `position: sticky` costs none of that.

The rest of the boundary:

- **Above `lg` only.** Mobile browsers change viewport height as their chrome hides and shows,
  which silently rewrites the travel distance mid-scroll; §7 wants one primary visual per screen on
  mobile regardless.
- **Scroll position is the single source of truth while pinned.** Autoplay is off — the reader is
  already driving — and the rail buttons scroll rather than set state, or the rail would drift from
  the page the moment the wheel moved.
- **Three complete modes, not one effect with degradations**: scroll-pinned; the existing sticky
  rail with autoplay (narrow viewports and the server render); and, under `prefers-reduced-motion`,
  the static stepper §6.3 mandates — no tall wrapper is rendered at all, so there is nothing to
  scroll through.
- **Keyboard operability is unchanged.** The rail entries stay buttons.

### C. Hallmark gate 47 does not apply to `web/components/product/**`

The Hallmark design skill forbids hand-built browser bars, phone frames and IDE chrome, on the
stated grounds that "the user's environment already supplies real chrome" and that the alternative
is a real screenshot in a `<figure>`.

That premise does not hold here. A website visitor has not installed the application, so no chrome
exists in their environment to borrow; and §8's amendment already establishes that the capture
matrix is empty, so there is no screenshot to use instead. Removing the frame would leave the
depicted diff, plan, permission checkpoint and artifact floating with no indication of what
application they belong to — which is the failure §8 was written to prevent.

So `AppFrame` keeps its window chrome **and** its required `label` prop, and the gate is skipped
for `web/components/product/**` only. The honesty mechanism §8 installed is doing the work that
gate 47 exists to do: every reconstruction is labelled in its own title bar, `ProductStage` repeats
the "not a screenshot" note in the figure caption, and a real capture still wins the moment one
exists. Gate 47 continues to apply everywhere else on the site.

## Amendment, 2026-09-05 — the stage bookends, a live hero, and grids that close

Four changes, recorded so the next redesign starts from the reasons rather than the pixels. The
review that produced them is a set of full-page captures of every route at 1440 and 390 wide, in
both themes; the defects named below are what those captures showed.

### A. The hero is the execution stage, and the workbench on it is live

The first screen was the paper brand layer with the product stage pushed below the fold. It is now
the dark stage itself: headline and actions on the left, and on the right the same
`WorkbenchReconstruction` that `ProductStage` renders, driven forward through five phases once the
page is interactive (request, reply typed, tool call, diff landing, `Waiting for approval`). The
sequence runs **once** and halts on the approval checkpoint, which is spec §6.1's narrative beat;
a loop would undo it every few seconds.

Three renders, each complete: the server paint shows the opening state with the request visible,
reduced motion shows the finished state immediately, everything else runs the sequence. The
depicted interface stays `aria-hidden` behind one `role="img"` exactly as §8 prescribes.

The mechanism is `.stage-scope` in `globals.css`: a class that remaps the reading tokens (`ink`,
`paper`, `surface`, `muted`, the hairlines, the four state colours) onto their stage counterparts
for everything inside it. The hero and the closing call to action are written in the ordinary
vocabulary and become stage surfaces by scope, so there is still one button, one rail, one
reconstruction. This is the same move `.signature-stage` already made in the other direction.

The hover lens moved from the hero to the desktop section: a magnifier over a surface that is
animating itself is two motions fighting.

### B. The section rhythm steps down one rung

`tight` / `normal` / `open` were 80 / 160 / 224 on desktop. Stacked on the sections' own inner
margins, the default produced 400–500px of empty paper between blocks, and on the sub-pages the
opening block's ruled ground read as the page having stalled. The scale is now 80 / 112 / 160 with
the same alternation, and the first capability section uses `normal` rather than `open`.

### C. Gapless grids fill their open cells with a reconstruction

`CapabilityGrid` paints its hairline track wherever there is no cell, so a section with two or four
entries showed a grey slab where the third and sixth would be (Workflows: Build and Run; Plugins:
what a plugin contributes). The grid now takes an `aside` that spans exactly the remainder at each
breakpoint, and the sections supply a labelled reconstruction of the surface they are about: the
workflow graph, the run ledger, and a plugin manifest read verbatim from
`plugins/web-tools/plugin.json` (a test pins the fixture to the file). This is §8's amendment
applied to a second place: a reconstruction that says it is one, never an empty frame.

The Workflows, Plugins and Trust sections also gain anchor ids, which gives their page headers the
"On this page" index the Product page already had.

### D. The changelog is a folded, paged feed with its index rendered

586 unreleased entries printed in full, with their Markdown markers literal, made the page
183,000px tall. Entries now render through a small parser that knows only the constructs the
entries use (`lib/markdown-inline.ts`) and refuses the rest as text; long bodies open folded to
their first block; months are `<details>` with twenty entries a page; and the bump-distribution
bar and month index that the copy had declared for months are finally rendered.

### E. Bounded evidence fetches

`build-evidence.mjs` runs as `predev`, and its GitHub calls had no deadline: on a machine with no
route to `api.github.com`, `pnpm web:dev` never started. The calls now abort after fifteen
seconds and fall through to the existing keep-the-previous-snapshot policy.

### F. Two more homepage sections: entry points and the whole instrument

The homepage argued for one workbench and never said where else it could be reached, or how
much of it there was. Two sections fill that, and the section order is now ten: hero, task,
workbench, desktop, **entry points**, run, connections, **the instrument**, trust, close.

*Entry points* puts five surfaces on one rail: the desktop runs the task, the paired phone
approves the checkpoint, a chat platform receives the result, the terminal resumes the
session, the browser companion adds a page. A marker travels the rail once and each station's
rule lights as it arrives, driven by the same one-shot `useScriptedPhases` the hero uses.
Every station holds a labelled miniature reconstruction of the same demo task. The two
commands shown are quoted from the modules that define them (`cognia-agent chat --continue`
from `cli/src/cli/args.ts`, the capture shortcut from `browser-extension/wxt.config.ts`) and the
chat platform list is pinned by test to the adapter directories under
`lib/connectors/adapters/`.

*The whole instrument* shows figures counted from the checkout at build time and places every
subsystem on one of four lanes that follow the page's spine: work, remember, reach, control.
`web/scripts/build-inventory.mjs` counts in-tree plugins, chat adapters, workflow node kinds,
Rust crates, workspace packages, numbered ADRs and test files, and writes them into
`evidence.json` beside the network figures. They are directory listings, not KPIs, and a zero
renders as a dash because zero means the count did not run.

### G. Texture, bespoke marks and index tags

Three additions to the visual system, each within the No AI Gradient Rule: a monochrome grain
film and a masked dot lattice for sections that hold an instrument, a registry of bespoke
1-unit-stroke marks (`components/glyph.tsx`) that name subsystems and can draw their stroke on
entry, and a zero-padded index tag with a tick rule on every homepage section heading. The
rules for each are in `web/DESIGN.md`.

### H. The workflows page demonstrates instead of listing

Four surfaces on `/workflows` now play once when they reach the viewport, all through one hook
(`useScene`: hydrated, on screen, motion permitted, which phase). The Build graph lands one node
per plan step and then draws a back-edge that is tagged as rejected, because validation refuses
every cycle on save. The Run ledger plays the four steps from not started to the fixture's
states. The event-to-evidence rail sends a marker across its four boundaries. And the closing
"What the runner guarantees" list became `RunnerGuarantees`: each of the four sentences sits
beside a miniature of the property it states, five triggers reaching one runner, a refused
cycle, a nesting counter stopping at `MAX_SUBWORKFLOW_DEPTH` (pinned by test to
`executor-support.ts`), and a run whose failed node leaves the rest recorded as skipped. Every
demonstration ends on its static picture, which is also what reduced motion renders, and every
picture is hidden from assistive technology behind the sentence it illustrates.

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
