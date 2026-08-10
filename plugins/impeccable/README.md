# Impeccable for Cognia

An installable Cognia plugin packaging the Impeccable 4.0.4 frontend-design skill.

The plugin contributes one desktop skill, `impeccable`, with its design references, deterministic anti-pattern detector, and supporting agents. It requests no Cognia plugin permissions; any file, shell, image, or network action remains behind the active chat session's normal permission gates.

## Safety profile

This adapter intentionally does not ship or expose Impeccable's `live`, hook-installation, or pin/unpin implementation:

- the upstream 4.0.4 live channel has an unresolved instruction-injection report;
- Claude/Codex edit hooks have no behaviorally equivalent Cognia declarative contribution;
- persistent `PRODUCT.md`, `DESIGN.md`, and `.impeccable/` changes require an explicit user request.

The ordinary design workflows remain available, including `shape`, `critique`, `audit`, `polish`, `distill`, `harden`, `adapt`, `animate`, `layout`, and `typeset`.

## Build and install

From this directory:

```bash
cognia plugin lint --json
cognia plugin build --json
cognia plugin info target/cognia/cognia-impeccable-0.1.0.zip --json
cognia plugin install target/cognia/cognia-impeccable-0.1.0.zip --json
```

Installation requires a running Cognia desktop instance. After enabling the plugin, attach the `impeccable` skill to a character or team in Cognia's skill picker, then ask for a design task such as `audit the settings screen` or `polish the onboarding form`.

The local-bundle skill is desktop-only because Cognia reads its supporting files through the desktop filesystem bridge.

## Layout

```text
plugin.json                 Cognia manifest and packaged-file allowlist
src/index.ts                activation lifecycle
src/index.test.ts           manifest, lifecycle, and bundle-integrity tests
dist/index.js               prebuilt runtime for build-free installation
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
