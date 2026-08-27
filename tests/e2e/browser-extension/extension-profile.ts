/**
 * Which build of the extension a spec loads, and the single way a test build
 * may differ from the shipped one.
 *
 * ## The deviation, and why it exists
 *
 * `http://127.0.0.1/*` ships as an **optional** host permission, requested
 * during pairing rather than at install (`wxt.config.ts`). That is the right
 * product decision and it makes the full loop untestable in an automated
 * browser: `chrome.permissions.request()` raises Chrome's native permission
 * bubble, which is browser chrome and not page content, so Playwright cannot
 * click it. Measured, not assumed — the call from a page with a real user
 * gesture never settles, and from a service worker it throws "must be called
 * during a user gesture". There is no switch, no CDP domain and no profile
 * pref that grants it: `extensions.settings` is a MAC-protected preference and
 * editing it makes Chrome discard the extension.
 *
 * So the loop specs load a copy whose manifest moves that one pattern from
 * `optional_host_permissions` into `host_permissions`, which Chrome grants at
 * install. Everything else — every line of panel code, the client, the DPoP
 * layer, the extractor, the key handling — is byte-identical to what ships.
 *
 * ## What the deviation costs, stated plainly
 *
 * Two things are then NOT covered by the loop specs, and neither may be
 * claimed:
 *
 *  1. **The permission prompt itself.** That the panel asks, that Chrome
 *     prompts, and that a refusal is handled. The refusal branch has a unit
 *     test (`client.test.ts`, "refuses without the loopback permission"); the
 *     prompt has no automated coverage anywhere and needs a human.
 *  2. **The `activeTab` gesture grant.** With a host permission covering
 *     `127.0.0.1`, `chrome.scripting.executeScript` on a fixture page served
 *     from there succeeds without a gesture. The shipped build reaches the
 *     same call through `activeTab`, granted by a toolbar click, a keyboard
 *     command or a context-menu choice — all native UI, all undrivable.
 *
 * `shipped-artifact.spec.ts` loads the real build precisely so the permission
 * posture that these specs cannot exercise is still asserted on the artifact
 * that users install.
 */
import { cp, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The `wxt build` output, which must exist before these specs run. */
export const SHIPPED_BUILD_DIR = join(process.cwd(), "browser-extension/build/chrome-mv3")

export type ExtensionProfile = "shipped" | "granted"

/** The one pattern that moves between permission lists. */
export const LOOPBACK_PATTERN = "http://127.0.0.1/*"

export interface ChromeManifest {
  permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  [key: string]: unknown
}

/**
 * The granted variant of a shipped manifest.
 *
 * Written as a pure function so `profile-deviation.spec.ts` can assert that it
 * changes exactly two keys and nothing else. A rewrite performed inline in the
 * fixture would be a rewrite nobody could check.
 */
export function grantedManifest(shipped: ChromeManifest): ChromeManifest {
  const optional = shipped.optional_host_permissions ?? []
  if (!optional.includes(LOOPBACK_PATTERN)) {
    throw new Error(
      `the shipped manifest no longer declares ${LOOPBACK_PATTERN} as optional; ` +
        "the test profile's deviation is stale and must be re-derived"
    )
  }
  const granted: ChromeManifest = {
    ...shipped,
    host_permissions: [...(shipped.host_permissions ?? []), LOOPBACK_PATTERN],
    optional_host_permissions: optional.filter((pattern) => pattern !== LOOPBACK_PATTERN),
  }
  // An empty list and an absent key are the same thing to Chrome, and keeping
  // the empty key would make the two manifests differ in a third place for no
  // reason — which is exactly what the deviation assertion is watching for.
  if (granted.optional_host_permissions?.length === 0) delete granted.optional_host_permissions
  return granted
}

export async function readShippedManifest(): Promise<ChromeManifest> {
  try {
    return JSON.parse(await readFile(join(SHIPPED_BUILD_DIR, "manifest.json"), "utf8"))
  } catch {
    throw new Error(
      `no extension build at ${SHIPPED_BUILD_DIR}. Run \`pnpm browser-ext:build\` first ` +
        "(or `pnpm browser-ext:e2e`, which builds and then runs these specs)."
    )
  }
}

let grantedDirPromise: Promise<string> | null = null

/**
 * The directory to hand `--load-extension`.
 *
 * Built once per worker process and reused: the copy is ~400 KB, but the
 * extension's id is derived from this path, so a per-test directory would
 * change the id on every test and force the mock Host's allowed origin to be
 * re-derived for each one.
 */
export async function extensionDirFor(profile: ExtensionProfile): Promise<string> {
  if (profile === "shipped") {
    await readShippedManifest()
    return realpath(SHIPPED_BUILD_DIR)
  }
  grantedDirPromise ??= (async () => {
    const shipped = await readShippedManifest()
    // Resolved, not as returned. On macOS `os.tmpdir()` is `/var/folders/…`,
    // a symlink to `/private/var/folders/…`; Chrome resolves it before hashing
    // the path into an extension id, so an unresolved path here derives an id
    // for an extension that does not exist and every panel navigation 404s.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cognia-ext-granted-")))
    await cp(SHIPPED_BUILD_DIR, dir, { recursive: true })
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(grantedManifest(shipped), null, 2),
      "utf8"
    )
    return dir
  })()
  return grantedDirPromise
}

/**
 * Chrome's id for an unpacked extension: the first 128 bits of SHA-256 over
 * the absolute path, each nibble mapped onto `a`–`p`.
 *
 * Reimplemented rather than read off the loaded extension because one spec
 * needs the id *before* the browser exists — the mock Host has to be told
 * which origin to allow, and allowing `*` would let the suite pass with an
 * origin the real Host would refuse.
 */
export async function unpackedExtensionId(dir: string): Promise<string> {
  const { createHash } = await import("node:crypto")
  const digest = createHash("sha256").update(dir, "utf8").digest("hex").slice(0, 32)
  return [...digest].map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join("")
}
