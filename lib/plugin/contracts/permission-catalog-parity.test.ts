/**
 * Gate: the permission catalog must describe every permission a plugin can
 * actually declare.
 *
 * Three lists have to agree, and nothing was previously checking that they do:
 *
 *  - `permissionMapping` (lib/plugin/api/permission-api.ts) — the manifest
 *    permission strings that grant an API permission. This is the authoritative
 *    "what can a plugin ask for and have it mean something".
 *  - `catalog.json` permissions — what the SDK, the manifest validator, and the
 *    generated Rust/Python contracts know about.
 *  - `PERMISSION_DESCRIPTIONS` — what the consent screen shows the user.
 *
 * They had drifted: 15 strings were live at runtime but absent from the catalog
 * and undescribed, so the permission-review UI fell back to
 * `PERMISSION_DESCRIPTIONS[perm] ?? perm` and asked users to grant a bare
 * `project:delete` / `vector:write` / `ai:chat` with no explanation of what it
 * does. Unknown permissions only warn in the manifest validator, so nothing
 * failed loudly — the drift just sat there.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CANONICAL_PLUGIN_PERMISSIONS } from "@cognia/plugin-sdk/contracts"
import { PERMISSION_DESCRIPTIONS } from "@/lib/plugin/security/permission-guard"

/**
 * Legacy aliases kept working for already-installed plugins but deliberately
 * NOT canonical — `legacyAliases` in permission-api.ts expands them. New
 * plugins must declare the canonical spelling, so these stay out of the catalog.
 */
const LEGACY_ALIAS_KEYS = new Set(["fs:read", "fs:write"])

/**
 * Mapping keys with no consumer. `notification:show` is vestigial: the
 * notification API is guard-enforced under the canonical `notification`
 * permission (which IS catalogued), and nothing reads the `notification:show`
 * API permission. Pre-existing; listed here so the gate stays honest rather
 * than being widened to hide it.
 */
const VESTIGIAL_MAPPING_KEYS = new Set(["notification:show"])

/**
 * Read the `permissionMapping` keys straight from source. Importing the module
 * would drag the whole plugin transport/registry graph into a `node`-env suite;
 * the keys are a flat literal, so reading them is both cheaper and immune to
 * the module's side effects.
 */
function readPermissionMappingKeys(): string[] {
  const source = readFileSync(join(process.cwd(), "lib/plugin/api/permission-api.ts"), "utf8")
  const start = source.indexOf("const permissionMapping")
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf("\n}", start))
  const keys = [...body.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1])
  // Guard the scraper itself: if the literal is ever reformatted into
  // something this regex misses, the test must fail rather than pass vacuously.
  expect(keys.length).toBeGreaterThan(40)
  return keys
}

const catalog = new Set<string>(CANONICAL_PLUGIN_PERMISSIONS)

describe("permission catalog parity", () => {
  it("catalogues every declarable permission that grants an API permission", () => {
    const undeclarable = readPermissionMappingKeys().filter(
      (key) => !catalog.has(key) && !LEGACY_ALIAS_KEYS.has(key) && !VESTIGIAL_MAPPING_KEYS.has(key)
    )

    expect(undeclarable).toEqual([])
  })

  it("gives the consent screen something to say about every catalogued permission", () => {
    // `PERMISSION_DESCRIPTIONS[perm] ?? perm` is what the marketplace detail
    // view and the WASM grant sheet render — a missing entry means the user is
    // asked to approve a raw permission string.
    const undescribed = [...catalog].filter(
      (permission) => !(permission in PERMISSION_DESCRIPTIONS)
    )

    expect(undescribed).toEqual([])
  })

  it("does not describe permissions that are not in the catalog", () => {
    // The reverse drift: a description for a string no plugin can declare is
    // dead weight that reads as support for something unsupported.
    const orphaned = Object.keys(PERMISSION_DESCRIPTIONS).filter(
      (permission) => !catalog.has(permission)
    )

    expect(orphaned).toEqual([])
  })

  it("catalogues the editor permissions the project-editor plugin API needs", () => {
    expect(catalog.has("editor:read")).toBe(true)
    expect(catalog.has("editor:write")).toBe(true)
  })

  it("keeps the catalog free of duplicates", () => {
    expect(CANONICAL_PLUGIN_PERMISSIONS.length).toBe(catalog.size)
  })
})
