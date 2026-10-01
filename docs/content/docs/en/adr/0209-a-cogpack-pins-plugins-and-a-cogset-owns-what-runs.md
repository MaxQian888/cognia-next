---
title: "0209 — A cogpack pins plugins; a cogset owns what runs"
description: "Plugin sets become two things. A cogpack is a signed, versioned `.cogpack` file that pins each plugin to an exact revision (by reference when the plugin can be fetched again, embedded when it cannot) and carries each member's non-secret config. A cogset is a named local set of plugins that owns which plugins should run and their non-secret config; switching is exclusive except for a host-kept always-on set, reconciles through the plugin manager rather than overlaying `plugins.enabled`, and can be bound to a workspace. Importing a cogpack creates a cogset. Every install records its origin in its own table so a cogset can be exported back into a cogpack."
---

# ADR 0209 — A cogpack pins plugins; a cogset owns what runs

**Status:** Accepted
**Date:** 2026-09-30
**Related:** [ADR-0100](./0100-unified-template-platform) (package envelope), [ADR-0164](./0164-templates-squads-and-commands-are-portable-and-iterable) (publisher identity and trust ledger), [ADR-0030](./0030-character-pack-overlay-capability) (standalone signed pack import), [ADR-0144](./0144-workspace-as-the-unit-of-work) (workspace), [ADR-0001](./0001-backup-schema-v3) (backup), [ADR-0027](./0027-mobile-offline-and-discovery) (mirrored clients)

## Context

People want what Minecraft players get from a modpack: one file that sets up a
known-good combination of plugins, and a way to keep several combinations and
move between them. Before this ADR the pieces existed separately and none of
them was that.

- **Marketplace presets** (`lib/plugin/package/github-marketplace.ts`,
  `lib/plugin/marketplace/preset-install.ts`) install a named list of plugins
  from one GitHub catalog in one click. Members are named, not pinned. They always
  install the latest revision, carry no config and no enabled state, and can only
  be authored by hand in a repository.
- **Dependencies** (`dependencies` / `optionalDependencies` in the manifest)
  order and auto-enable plugins that are already installed
  (`lib/plugin/core/load-order.ts`), but the GitHub install path does not install
  missing ones.
- **The data backup** (`lib/data/build-package.ts`) exports plugin rows but not
  plugin code, forces `enabled` to false on restore, and is a whole-app backup,
  not something to hand to someone else.
- **Nothing recorded where an installed plugin came from.** The GitHub installer
  resolved a commit SHA and then dropped it; the git WASM installer never knew
  which commit it cloned. A plugin set could not be exported with pins because
  the pins were never kept.
- **Plugins are deliberately not per-workspace.** `lib/workspace/capability-overlay.ts`
  explains why: `plugins.enabled` is the runtime's loaded state, written as a
  consequence of activation, so overlaying it per workspace would rewrite the
  column that records what is actually running. Doing it properly needs
  something that owns *intent* separately from what is loaded.

Two words are already taken. "Profile" in `lib/plugin/core` means the runtime
host profile (`PluginRuntimeProfile`: browser, tauri, mobile), and "pack" means a
character pack, a theme pack or a style pack. The names come from Cognia's own
"cog": a plugin is a cog in the machine, a **cogset** is the set of cogs that
turn together (like a bicycle's gear set, you change it to change how the
machine runs), and a **cogpack** is the packed-up cogset you hand to someone
else. User-facing Chinese copy uses 齿轮组 (cogset) and 齿轮包 (cogpack).

## Glossary

- **Cogpack**: a signed, versioned, shareable file (`.cogpack`) naming a set of
  plugins, each pinned to an exact revision, with each member's non-secret
  config. Every member is meant to run; a member marked `optional` may be
  skipped by the importer. _Avoid_: modpack, plugin pack, bundle, preset.
- **Cogset**: a named, local set of plugins that should run together, with each
  member's non-secret config. At most one cogset is applied on a host.
  _Avoid_: loadout, profile (the runtime host profile), instance.
- **Always-on set**: plugins enabled under every cogset. It is local to the
  host and never travels in a cogpack.
- **Install origin**: where an installed plugin came from, pinned to exactly
  what was installed (a commit, a registry version, a bundle hash, an Open VSX
  version and VSIX hash, "ships with the app", or "local").
- **Effective cogset**: the cogset that should be running: a session override,
  else the active workspace's binding, else the global choice.
- **Preset**: unchanged meaning, a named, unpinned list in a marketplace
  catalog. A preset can be saved as a cogset. It is not a cogpack.

## Decision

### 1. A cogpack references plugins it can re-fetch and embeds the rest

A cogpack is a zip whose manifest is RFC 8785 canonical JSON (the
canonicalization character packs sign), with a sha256 record per file, hardened
extraction and an Ed25519 signature over the canonical manifest. The archive
half — deterministic output, path/size/count/ratio limits, per-file checks, the
undeclared-file rule and signature verification — is shared with template
packages in `lib/packaging/signed-zip.ts`; each format keeps its own manifest.

The manifest (`lib/plugin/cogpack/manifest.ts`, validated strictly: anything
this version does not understand is refused) has `schemaVersion`,
`kind: "cognia.cogpack"`, `id`, `version`, `name`, `description`,
`compatibility.minHostVersion` (the exporting app's version, which built-in
members need) and one entry per member:

- `id`, `name`, `version`, `optional`;
- `source`, one of:
  - `builtin` (ships with the app);
  - `github` (owner, repo, subdir, full commit);
  - `git` (https URL, full commit);
  - `registry` (registry URL, version, checksum);
  - `url` (bundle URL, sha256 of the verified bundle, signature URL and key);
  - `openvsx` (namespace, name, version, VSIX sha256, target platform);
  - `embedded` (the plugin tree under `plugins/<id>/`, every file hashed);
- `config`: the non-secret configuration;
- `secretFields`: the names, and only the names, of `secret: true` config fields
  the importer must fill in.

A member is referenced only when its recorded origin is reproducible *and* was
recorded for the version that is installed; otherwise it is embedded. This is
the Modrinth `.mrpack` split between downloads and overrides. A plugin installed
from a VS Code file cannot be carried (the directory installer cannot reinstall
an unpacked extension) and is listed as such rather than dropped silently.

Secrets never travel. A `secret: true` value is currently stored with the rest
of the plugin's config (`plugin-config-form.tsx` says so), so the exporter strips
every secret field (`lib/plugin/core/config-secrets.ts`) and writes only the
field names. The export dialog shows every non-secret value it is about to write
and lets the user leave any member's config out, because a field that is not
marked secret can still hold something private.

### 2. Every install records its origin, in its own table

`pluginInstallOrigins` (keyed by plugin id) holds one record per installed
plugin. It is a table rather than a field on the plugin row because several
installers never write that row themselves (the HTTP registry path leaves it to
discovery) and discovery re-projects the row on every launch.

Every install path writes it through `recordInstallOrigin`:

- the GitHub installer, after resolving any branch or tag to a full commit
  first, so the origin names exactly what was downloaded;
- the git WASM installer, whose host command now checks out an exact commit
  when given one and reports the commit it cloned when not;
- the HTTP registry (version and checksum), signed URL bundles (verified hash),
  Open VSX (version and VSIX hash);
- local directories, local WASM files, dropped VSIX files and manifest imports
  (`local`, not re-fetchable);
- installer-bundled plugins (`builtin`); browser built-ins are recognized by
  their `builtin://` path and need no record;
- cogpack imports, which add the cogpack's id, version and fingerprint.

A record never fails an install; a plugin without one exports as embedded. On a
mirrored client the install runs on the host, so the record is sent there
(`plugin_install_origin_record`). A record that did not come from an install on
this host, whether forwarded by a paired client or restored from a backup, is
validated by `parseInstallOriginRecord` with the same checks a cogpack member
source gets (https URLs, full commit ids, sha256 pins), because a later export
pins exactly what it says. A refused record only means that plugin exports
embedded. `lib/plugin/origin/install-paths.test.ts` fails
when a host install command is invoked from a module that does not record.

### 3. A cogset owns intent; the manager does the switching

`plugins.enabled` and `lifecycle.actual` keep meaning what is loaded right now.
A cogset owns what *should* run, and activating it (`lib/plugin/cogset/reconcile.ts`)
is a reconciliation through `togglePluginEnabled` → `PluginManager.setPluginIntent`,
the path every manual toggle takes, never a write to the column.

Switching is **exclusive**:

- The target set is the cogset's members ∪ the always-on set ∪ the required
  dependency closure of both, planned up front by `lib/plugin/cogset/plan.ts`.
- Plugins outside the target set are disabled, dependents first. Nothing is
  uninstalled.
- Before anything changes, the outgoing cogset's members' current non-secret
  config is saved back into it, so every cogset keeps its own configuration.
- Member config is applied (the plugin's own secrets kept) before enabling, and
  enables run in `resolveLoadOrder` order.
- Every plugin's result is recorded with structured fields (the unmet
  dependency and its range, the version found, the plugins in a cycle) that the
  UI translates; only a plugin manager's own failure carries free text. A
  failure leaves that plugin where the
  manager left it and marks the cogset "partial"; nothing that switched
  successfully is rolled back, and Retry re-runs the reconciliation. A missing
  optional member does not make a cogset partial.
- Activations are serialized.

While a cogset is applied, manual enables, disables and settings edits write
through to it (`write-through.ts`, driven by a plugin-intent event that
`setPluginIntent` now emits and a host-wide config-change subscription). The
reconciliation's own changes are ignored. On first run the host creates a
**Default** cogset from what is enabled, so turning the feature on changes
nothing visible.

### 4. One installed version per plugin

A host holds one installed version of each plugin: the runtime keys everything
by plugin id. A cogset member may name an `expectedVersion`; a mismatch is
reported on activation (the installed version still runs), and the auto-updater
never installs an update that would move a plugin off the version the applied
cogset pins — it offers that update instead.

### 5. Importing a cogpack creates a cogset

Import (`lib/plugin/cogpack/import.ts`) is a plan, one review, then installs:

1. The file is verified (`inspectCogpack`): structure, hashes, signature.
2. Trust is resolved under the plugin policy (decision 6).
3. Every member is resolved at its pinned revision by the installer that
   already exists for its source (`resolvers.ts`), and compared with what is
   installed: same, different version, new, or unavailable.
4. The review shows, in one dialog, each member's permissions, missing binaries
   and conflicts (the marketplace install flow's own checks), the secret fields
   to fill in, required dependencies the cogpack does not carry (shown, never
   installed silently), and which installed plugins activating the result would
   turn off. For a member installed at another version the user chooses to
   install the pinned one or keep theirs (then the cogset pins theirs).

WASM members are installed with the capability grant the review showed
(`defaultWasmGrantDecision`, the grant sheet's own default). A git member cannot
be previewed without cloning, so its capabilities are reviewed right after it
installs. Embedded members are written and installed by the host
(`plugin_install_from_files`), through the same directory installer as "Load
unpacked", on a blocking thread. The command takes the member id the review
showed and refuses a tree whose `plugin.json` names another plugin, so an
embedded member can never replace a different installed plugin. Paths are
refused when a case-insensitive file system would store two of them as one file
(`PLUGIN.JSON` beside `plugin.json`), or when they carry an NTFS stream, a
Windows device name or a trailing dot or space; the review refuses such a tree
too, so what is installed is what was reviewed. Secrets the user typed go to the plugin's config, never into the
cogset. The result is a new cogset that remembers its cogpack; activating it is
offered, not forced. Members that did not install stay in the cogset and are
listed as missing.

Importing a newer version of a cogpack imported before offers to update that
cogset. `update-diff.ts` compares the earlier manifest, the new one and the
cogset now: upstream changes apply, and where the user changed a member locally
their version wins unless they pick the new one, per plugin. Deleting a cogset
also deletes the import records that point at it, so a later import starts a
new cogset instead of updating a missing one. It never uninstalls; it offers to uninstall the plugins no other cogset or the
always-on set uses.

### 6. Cogpacks are signed by default; unsigned ones import with a warning

Export signs with the publisher identity of ADR-0164 whenever the user keeps
signing on (a key is created on first use), so a template publisher, a plugin
publisher and a cogpack publisher are one row in the trust ledger. Import shows
trusted publisher, signed by an unknown publisher, or unsigned. The plugin
policy applies as it does to plugins: "signatures required" refuses an unsigned
cogpack, "trusted publishers only" also refuses an unknown signer. Trusting a
signer at import adds it to the ledger.

### 7. A workspace can bind a cogset

`Project.pluginCogsetId` binds a workspace to a cogset. The effective cogset is
the session override, else the active workspace's binding, else the global
choice; references to deleted cogsets are skipped. A switch made while a
workspace binding is in force becomes a session override; changing workspace
clears it.

The follower (`follower.ts`) reconciles whenever the effective cogset differs
from the applied one. Such automatic switches wait while any agent run is
registered with the execution broker, which sees every AI turn (chat,
workflows, schedules, subagents, teams): disabling a plugin under a running
turn removes tools that turn is using. The wait is recorded as `pending` and
shown. A manual switch asks the user instead.

### 8. Where each part runs

- **Cogset state** lives in `pluginCogsets` and the `pluginCogsetState`
  singleton, host-authoritative, synced read-only to paired clients like
  `plugins`. A paired client switches by queuing `plugin_cogset_activate`; the
  host records the scope and lets the follower apply it. Editing is host-only,
  and the UI says so.
- **The headless host** runs the same bootstrap, write-through and follower.
- **Cogpack import and export** need a host with installers (the desktop).
- **Backups** (ADR-0001) carry cogsets, cogpack imports, origins and the host's
  choices (always-on set, global cogset), not what it last applied; plugin ids
  are remapped on restore.
- **Presets** stay. After a preset installs, saving it as a cogset is offered.

## Considered options

- **An install directory per cogset** (Minecraft instances, side-by-side
  versions): rejected. Plugin storage, plugin Dexie tables, the keyring
  namespace and runtime registration are all keyed by plugin id, so two versions
  of one plugin cannot coexist without re-keying the runtime.
- **Overlaying `plugins.enabled` per workspace**: rejected for the reason
  `capability-overlay.ts` gives. The cogset owns intent and the manager applies
  it.
- **Additive switching** (enable only): rejected. Cogsets would leak into each
  other and "switch to X" would not mean "run X".
- **Reference-only cogpacks**: rejected. They could not carry local or private
  plugins, and every install from before this ADR has no origin.
- **Embed everything**: rejected. Files grow large, the cogpack redistributes
  third-party code, and it loses the provenance a reference keeps.
- **Extending presets into cogpacks**: rejected as the format. A preset lives
  inside one GitHub catalog and names members by catalog name. It stays as a
  discovery surface that feeds cogsets.
- **Origins as a plugin-row field**: rejected during implementation; see
  decision 2.
- **Cogset state in `AppSettings`**: rejected. It would change the settings
  contract package and its sync keys for state that has its own lifecycle; two
  tables synced like `plugins` keep it host-authoritative with no contract churn.

## Consequences

- Dexie v235 adds `pluginInstallOrigins`, `pluginCogsets`, `pluginCogsetState`
  and `cogpackInstalls`, registered in the governance catalog, the backup
  package and (the two cogset tables) companion sync.
- Two host commands join the companion contract (`plugin_cogset_activate`,
  `plugin_install_origin_record`) and two desktop commands the Tauri shell
  (`plugin_export_tree`, `plugin_install_from_files`).
- Switching cogsets restarts plugins; its cost grows with the number of plugins
  that change, and the UI reports progress per plugin.
- A pinned version is a request, not a guarantee: the updater holds pinned
  updates, but an explicit update by the user still moves the plugin, and the
  next activation reports the mismatch.
