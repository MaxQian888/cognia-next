/**
 * Character Seeds — copy-paste template for the `character-pack` capability
 * (ADR-0030).
 *
 * Ships two demo packs in plugin.json:
 *  - **Workplace Suite** — work personas (PM, technical interviewer, code
 *    reviewer).
 *  - **Study Buddies** — study companions (Socratic tutor, flashcard drill
 *    master).
 *
 * The pattern to copy, and nothing more:
 *  1. Author each pack under `characterPacks[]` in plugin.json. An installed
 *     plugin's manifest IS its plugin.json: the manager checks the module
 *     manifest against it before activation (`assertPluginManifestParity`) and
 *     refuses to load a plugin whose TypeScript declares packs the file lacks.
 *  2. Export `definePluginManifest(...)` over the JSON. Running each pack
 *     through `defineCharacterPack` type-checks it against
 *     `PluginCharacterPackDef` at compile time and applies the SDK's load-time
 *     rules (at least one character, unique `localId`s, the soft size limit),
 *     without changing a single value — so parity still holds.
 *  3. Register nothing in `activate()`. The manager's `character-pack`
 *     dispatch registers every declared pack on enable and drops them on
 *     disable; an imperative `ctx.characterPacks.register` would only
 *     overwrite the entry it just wrote.
 *
 * The template declares no activation events: demo personas appear only for a
 * user who installs and enables it.
 */

import { defineCharacterPack, definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest({
  ...manifestJson,
  characterPacks: manifestJson.characterPacks.map((pack) => defineCharacterPack(pack)),
})

export default definePlugin({
  manifest,
  activate: () => {},
})
