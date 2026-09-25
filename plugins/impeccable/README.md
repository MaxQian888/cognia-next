# Impeccable for Cognia

An installable Cognia plugin packaging the Impeccable 4.0.4 frontend-design skill.

The plugin contributes one desktop skill, **Impeccable (frontend design)** (`cognia-impeccable:impeccable`), with its design references, deterministic anti-pattern detector, and supporting agents. It requests no Cognia plugin permissions; any file, shell, image, or network action remains behind the active chat session's normal permission gates.

## Safety profile

This adapter intentionally does not ship or expose Impeccable's `live`, hook-installation, or pin/unpin implementation:

- the upstream 4.0.4 live channel has an unresolved instruction-injection report;
- Claude/Codex edit hooks have no behaviorally equivalent Cognia declarative contribution;
- persistent `PRODUCT.md`, `DESIGN.md`, and `.impeccable/` changes require an explicit user request.

The ordinary design workflows remain available, including `shape`, `critique`, `audit`, `polish`, `distill`, `harden`, `adapt`, `animate`, `layout`, and `typeset`.

## Build and install

From the repository root (the build reuses the root install's `esbuild` and
`jszip`; `dist/` is gitignored build output):

```bash
pnpm exec node plugins/impeccable/build.mjs
```

That writes `plugins/impeccable/dist/index.js` and the installable
`plugins/impeccable/dist/cognia-impeccable-0.1.0.zip`. The manifest's `main`
is `dist/index.js`, so the plugin cannot load — from the ZIP or from this
directory — until that build has run. Install the zip into a running Cognia
desktop instance, e.g.:

```bash
cognia plugin install plugins/impeccable/dist/cognia-impeccable-0.1.0.zip --json
```

(or use the local `.zip` install action in the desktop app's **Plugins** panel).

After enabling the plugin, turn the skill on for a conversation from the chat composer's skill picker (type `@skill:` and pick **Impeccable (frontend design)**), then ask for a design task such as `audit the settings screen` or `polish the onboarding form`. The skill pre-approves only `Bash` and `Read`, which its detector scripts and references need; anything else still goes through the session's normal permission prompts.

The local-bundle skill is desktop-only because Cognia reads its supporting files through the desktop filesystem bridge.

Tests run under the repository's root Jest (`pnpm test -- plugins/impeccable`);
there is no separate per-plugin toolchain.

## Layout

```text
plugin.json                 Cognia manifest and packaged-file allowlist
src/index.ts                activation lifecycle
src/index.test.ts           manifest, lifecycle, and bundle-integrity tests
build.mjs                   esbuild + zip packaging driven by bundle_include
build.test.mjs              install-zip contract test
dist/                       gitignored build output (entry + install zip)
skills/impeccable/          adapted upstream skill, references, scripts, and agents
LICENSE                     upstream Apache-2.0 license
NOTICE.md                   upstream attribution notice
```

## Provenance

- Upstream: <https://github.com/pbakaus/impeccable>
- Pinned source: `skill-v4.0.4` / commit `9a949fb543d44cfb406f61bcab99d95d7f12cf1d`
- Cognia wrapper version: `0.1.0`
- License: Apache-2.0; see `LICENSE` and `NOTICE.md`

The initial scaffold was produced by `cognia plugin import --from skill`; the Cognia adapter then restores upstream resource directories, binds paths through `${COGNIA_PLUGIN_ROOT}`, and applies the safety profile above.
