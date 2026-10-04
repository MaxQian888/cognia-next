---
title: "0210 — A plugin can carry a Pi package"
description: "A Cognia plugin can include a complete Pi coding-agent package as a `piPackages` contribution with capability `pi-package`. Cognia prepares dependencies through a consented step that uses no shell. It installs the package into the user's Pi with `pi install <absolute path>`, with settings-edit fallback. A `pi-rpc` agent must opt in by reference to load declared extensions into a hosted session with `-e`. Plugin configuration uses the allowed `COGNIA_PIPKG_` environment prefix, which no other component reads. The plugin converter preserves foreign Pi packages byte-for-byte as contributions. Vendor formats were refreshed against documentation dated 2026-10-02."
---

# ADR 0210 — A plugin can carry a Pi package

**Status:** Accepted
**Date:** 2026-10-02
**Related:** [ADR-0119](./0119-pi-native-rpc-integration) (Pi native RPC, extension isolation, agent packages), [ADR-0051](./0051-external-agent-adapter-plugin-type) (external-agent plugin types), [ADR-0155](./0155-plugins-reach-the-host-through-one-door) (plugin SDK boundary), [ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin) (in-tree plugins), [ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs) (install origins)

## Context

The Pi LaTeX Workbench (`github.com/Arxtect/pi-latex-workbench`) is a Pi
package: a `package.json` whose `pi.extensions` names a TypeScript extension
that registers eight governed `latex_*` tools, plus a `latexwb` host CLI and a
resource tree (skills, templates, workflows, policies). Making it a Cognia
plugin exposed three gaps.

- **Nothing let a plugin hand something to Pi.** `lib/pi-packages/` already
  runs `pi install|remove|update` (with a `settings.json` fallback), but only
  from the Agent packages pane, through code plugins cannot import. No manifest
  field said "this plugin ships a Pi package".
- **Hosted Pi sessions load exactly one extension.** ADR-0119 pins Cognia's own
  digest-checked extension with `-e`. A plugin extension had no path into a
  hosted session, and the external-agent env policy drops every variable not on
  its allowlist, so a package that is configured through its environment (the
  workbench binds its project through `LATEXWB_*`) could not be configured.
- **The converter treated Pi as skills-only.** `pi.extensions`, `pi.prompts`,
  `pi.themes`, `dependencies` and `scripts` were blocking, so converting a real
  Pi package always failed, and the export wrote only `pi.skills`. Several other
  vendor adapters had drifted from their published contracts (Kimi's manifest is
  a root `plugin.json` with `tools[]`; Agent Plugins has a 1.1.0 draft and
  client namespace directories; Codex reads four manifest locations and migrates
  commands to skills; Cursor added rules, agents, commands, hooks and
  variables), and five formats with real manifests were missing.

## Decision

### 1. `piPackages` is a plugin contribution

`types/plugin/plugin-pi-package.ts` defines `PluginPiPackageDef`, declared under
`manifest.piPackages` with capability `pi-package`. An entry names a
plugin-relative package directory, an optional `minPiVersion`, an optional
`prepare` step and an optional `hostedSession` block. The directory is a
complete Pi package — Cognia does not rewrite it, so what Pi loads is exactly
what the author shipped.

A `builtin://` plugin has no directory Pi could read, so the capability is
refused for builtins.

### 2. Preparing dependencies is a consented, fixed step

Pi does not install dependencies for local packages. `prepare` declares one
package-manager invocation (`npm` or `pnpm`, static argv, plugin-relative
marker, clamped timeout). It runs without a shell, after a consent prompt that
shows the exact argv, and installing into Pi requires it to have run when it is
declared. Host packages (`@earendil-works/pi-*`, `typebox`) must stay out of the
package's `node_modules` — Pi maps them to its own copies — so the workbench's
step uses `--omit=dev --omit=peer --ignore-scripts`. The plugin runtime refuses
to load a plugin tree that contains a symbolic link, so the host appends
`--no-bin-links` to an `npm` step (shown in the consent prompt), checks the
package directory for links after the run (`symlinks-created`), and the
validator warns that `pnpm` links by default. At install time the catalog's
path-field `kind` decides what must already exist: `path` an existing
directory (`.` is the plugin root), each hosted extension an existing file, and
the marker only lexical containment — it appears after `prepare`.

### 3. Installing into Pi reuses the Pi package manager

Install and remove delegate to `runPiMutation` in `lib/pi-packages/host.ts`
with the absolute package directory as the spec, at user or project scope.
When Pi is not reachable the mutation degrades to a `settings.json` edit, and
the UI says so, exactly as the Agent packages pane already does. Install state
is read back through `loadPiPackages` and `piPackageIdentity`, so a package
installed from Cognia and one installed by hand with `pi install` are the same
entry.

### 4. Hosted sessions load a package only for an agent that opts in

A package with `hostedSession` may be selected per `pi-rpc` agent (agent
metadata `piPackages: ["<pluginId>/<packageId>"]`). Loading is per agent, never
global, because an extension can take over the session: the workbench restricts
the active tools to its own eight and blocks every other call
(`controlsSession: true` is shown before an agent opts in).

At session start the adapter resolves each reference — a missing, disabled or
unprepared package fails the start with a typed error instead of being skipped
— and appends one `-e <absolute path>` per declared extension before Cognia's
own extension, which still loads and still intercepts every tool call. Declared
`tools` pass the `--tools` floor only where the session already pre-approves
them (`dontAsk`), and every call is still decided by the permission table's
extension fallback. The handshake budget grows by 15 s per plugin extension,
inside the existing 120 s cap.

The sandbox mounts each resolved package directory read-only for the `pi`
command only. The adapter's `COGNIA_TOOLHOST_PI_PACKAGE_ROOTS` list is a
request, never a grant: the variable rides the reviewed `COGNIA_TOOLHOST_`
prefix, so anything that can set a spawn's env could name a path in it. The
remote spawn policy (`SpawnPolicy::validate`) therefore drops it outright —
remote callers never name sandbox roots — and the desktop wrapper keeps an
entry only when it canonicalizes (symlinks resolved) to an existing directory
strictly nested under the plugin install root the HOST derives from its own
data directory (`<data dir>/cognia/plugins`), never from renderer input. An
entry is also dropped, with a logged reason, when the part below that root
names a protected path, when it is or contains a forbidden readable root (in
every spelling, including `/private/var` and `/private/tmp`), or when it lies
under any `--deny-readable` root the wrapper emits — the launcher re-opens a
readable nested under a deny, so a Bot-isolated home, a gateway task's deny
list and the task-home parent all stay closed. A Bot-isolated agent therefore
cannot load plugin packages, and the adapter refuses that start with
`bot-isolation` instead of letting Pi miss the file. A value typed into the
agent's own env is discarded; only resolved packages set it. Pi deduplicates extensions by
canonical path, so an extension inside the package directory loads once even
when the same package is also installed into the scope the session reads. A
wrapper extension outside the package directory cannot be deduplicated: when
the session's extension policy would also load the installed copy, the start is
refused (`double-load`) and the user is told to isolate the agent or remove the
package from that Pi scope, rather than silently dropping the wrapper's
configuration.

### 5. Configuration reaches the extension through `COGNIA_PIPKG_`

`hostedSession.env` binds names to plugin configuration keys, manifest literals
or the session workspace. They are forwarded as `COGNIA_PIPKG_<NAME>`, and
`COGNIA_PIPKG_` is added to the external-agent env prefix allowlist (Rust
`presets.rs` and the CLI Node backend). The prefix is safe to admit because no
program reads it except an extension written to cooperate; a plugin still
cannot set `NODE_OPTIONS`, `LD_PRELOAD`, a provider credential or any other
variable, and no value comes from the model. The policy also drops every
`COGNIA_PIPKG_*` key from a spawn whose command is not Pi. The guarantee holds
at LAUNCH only: once Pi is running, extension code — the plugin's included —
can set any variable for the processes it spawns itself; the prefix bounds
what Cognia hands the process, not what code inside it does. The workbench's glue extension
maps `COGNIA_PIPKG_LATEXWB_*` onto `LATEXWB_*` only where the latter is unset,
then loads the vendored extension unchanged.

### 6. The converter keeps Pi packages whole

Importing a Pi package converts its skills and prompts to Cognia skills and
retains the whole package byte-for-byte, in place (`path: "."`), as one
`piPackages` entry, so delivering it back to Pi is exact. It stays in place
because the GitHub and load-unpacked installers may only add `plugin.json` and
`dist/index.js` to a source tree. Extensions are not translated into Cognia tools: they
remain Pi-only and become hosted only when an author declares and reviews a
`hostedSession`. Exporting to Pi writes the single `piPackages` entry as the
package root and merges exported skills into `pi.skills`.

The vendor adapters were refreshed against the documentation retrieved on
2026-10-02 (recorded in `docs/research/`), and Factory Droid, Qoder,
CodeBuddy, Auggie and the Open Plugins (`.plugin/plugin.json`) layout were
added. Qwen Code, Kiro Powers and code-only plugin systems (Amp, Cline, Zed)
are out of scope.

### 7. The workbench plugin vendors its upstream untouched

`plugins/pi-latex-workbench/` vendors the upstream source at a recorded commit
under `vendor/` (no tests, fixtures, recorded runs or the provisioned
toolchain), checked by a sync script, excluded from Cognia's TypeScript, Jest,
ESLint and author-import gates. Cognia agents use the host CLI through
`cliTools` whose argv literals now expand `${COGNIA_PLUGIN_ROOT}`; no tool
exposes an approval or grant surface, because the workbench's trust boundary is
that the model never approves its own work. Approvals stay with the operator,
in the Pi session or the host CLI.

## Consequences

- Any plugin can ship a Pi package; the workbench is the first.
- `pi install` from Cognia and by hand converge on one settings entry.
- A hosted Pi agent that opts in becomes a controlled worker; one that does not
  is unchanged.
- The upstream workbench has no LICENSE file. Its distribution terms must be
  confirmed with the owner before the plugin is published outside this
  repository.
- Rendering stays macOS-arm64-only and the ~2.9 GB tectonic bundle is a host
  provisioning step the user runs, not a tool call (it exceeds the 600 s
  `cliTools` cap).
