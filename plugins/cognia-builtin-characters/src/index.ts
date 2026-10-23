/**
 * First-party "built-in" character pack.
 *
 * Pre-v49, the six characters below were hard-coded inside
 * `lib/db/characters.ts:seedBuiltInCharacters` and written directly to
 * Dexie on first run. ADR-0030 §D5 originally argued that the built-ins
 * should stay out of the overlay registry (different lifecycle, different
 * Dexie attribution). The v49 plan reverses that decision so the built-ins
 * benefit from the same Apply-Update flow as third-party packs.
 *
 * The legacy `char_builtin_*` Dexie rows still exist — the host seeds and
 * tags them with this plugin's id + pack id (it reads the pack from the
 * generated pre-boot snapshot, never from this source), so `listCharacters`
 * recognises them as clones of the synthetic overlay characters this file
 * registers, and the
 * `clone-hides-overlay` dedupe rule in `listCharacters` keeps the visible
 * picker entries unchanged. Users who never customised a built-in
 * therefore see no UI difference; users who edited one keep their edits
 * and pick up the new persona / voice metadata via "Apply update".
 *
 * Lift-and-shift contract: every `localId` here MUST round-trip with the
 * host's legacy-id map. Changing a localId would orphan existing user
 * customisations.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { BUILTIN_PACK } from "./characters"

export { BUILTIN_PACK }

export const BUILTIN_PLUGIN_ID = manifestJson.id

/**
 * plugin.json plus the one TypeScript-authored field. `characterPacks` comes
 * from `./characters`; the browser builtin registry merges this manifest over the JSON at
 * discovery, and the manager's `character-pack` overlay dispatch registers the
 * pack on enable and drops it on disable. `activate()` therefore has nothing to
 * register — a second, imperative `ctx.characterPacks.register` only replaced
 * the entry the manager had just written.
 *
 * The plugin keeps `activationEvents: ["startup"]`: the default personas (and
 * the read-only Support Agent) must exist for every user without opting in.
 */
export const manifest = definePluginManifest({ ...manifestJson, characterPacks: [BUILTIN_PACK] })

export default definePlugin({
  manifest,
  activate: () => {},
})
