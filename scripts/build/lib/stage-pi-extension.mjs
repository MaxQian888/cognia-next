// Stage the bundled Cognia Pi extension into a packaged sidecar layout
// (ADR-0119).
//
// The extension is what intercepts Pi's native `read`/`edit`/`write`/`bash`
// calls and applies Cognia's permission matrix. `verifyPiExtension` refuses a
// session when the file is absent, so a layout that omits it does not degrade
// to "Pi without interception" — it makes Pi unusable on that host entirely.
// The desktop app ships the extension through Tauri's resource bundle; the
// CLI/brain layout had no equivalent step, which is why the Docker brain could
// never start a Pi session.
//
// Both files must travel together and keep their `sidecar/pi-extension/`
// shape: `resolvePiExtensionScript` walks up from the bundle looking for that
// exact relative path, and `verifyPiExtension` derives the manifest location
// from it by stripping the same suffix.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { buildSync } from "esbuild"

/** Mirrors `EXTENSION_RELATIVE` / `INTEGRITY_RELATIVE` in cli/src/agent/tool-host/pi-extension.ts. */
export const PI_EXTENSION_DIR = "pi-extension"
export const PI_EXTENSION_FILE = "cognia-pi-extension.ts"
export const PI_INTEGRITY_FILE = "integrity.json"

/** SHA-256 of a file's bytes, lowercase hex — the digest form the manifest pins. */
function digestOf(file, read = fs.readFileSync) {
  return createHash("sha256").update(read(file)).digest("hex")
}

/**
 * Bundle `sidecar/pi-extension/cognia-pi-extension.ts` and its dependencies
 * into `<sidecarOutDir>/pi-extension/`, verifying the source pin first and
 * writing a manifest for the compiled artifact consumed by the host verifier.
 *
 * The digest is checked HERE rather than left to the runtime because the two
 * failures are not equally recoverable. A stale pin caught at build time is a
 * forgotten `pnpm pi:extension:pin`; the same stale pin shipped is an image in
 * which every Pi session refuses with "does not match its pinned digest" and
 * the only fix is a new release. `pi:extension:pin:check` already gates the
 * repo, but the build must not depend on a sibling gate having run.
 *
 * Throws on a missing file, an unparseable/unpinned manifest, or a mismatch.
 * Returns the digest and the staged paths so the caller can log what shipped.
 */
export function stagePiExtension({ root, sidecarOutDir, fsImpl = fs } = {}) {
  if (!root) throw new Error("stagePiExtension: `root` is required")
  if (!sidecarOutDir) throw new Error("stagePiExtension: `sidecarOutDir` is required")

  const srcDir = path.join(root, "sidecar", PI_EXTENSION_DIR)
  const srcExtension = path.join(srcDir, PI_EXTENSION_FILE)
  const srcIntegrity = path.join(srcDir, PI_INTEGRITY_FILE)

  for (const src of [srcExtension, srcIntegrity]) {
    if (!fsImpl.existsSync(src)) {
      throw new Error(
        `stagePiExtension: missing ${path.relative(root, src)} — the Pi extension must ship with the sidecar layout, or every Pi session on this host refuses to start.`
      )
    }
  }

  let pinned
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(srcIntegrity, "utf8"))
    pinned = typeof parsed?.sha256 === "string" ? parsed.sha256.toLowerCase() : undefined
  } catch (error) {
    throw new Error(
      `stagePiExtension: ${path.relative(root, srcIntegrity)} is not readable JSON: ${String(error)}`
    )
  }
  if (!pinned) {
    throw new Error(
      `stagePiExtension: ${path.relative(root, srcIntegrity)} has no \`sha256\` — an unpinned extension is refused at runtime.`
    )
  }

  const actual = digestOf(srcExtension, (p) => fsImpl.readFileSync(p))
  if (actual !== pinned) {
    throw new Error(
      `stagePiExtension: ${PI_EXTENSION_FILE} does not match its pinned digest\n` +
        `  expected ${pinned}\n  found    ${actual}\n  run: pnpm pi:extension:pin`
    )
  }

  const destDir = path.join(sidecarOutDir, PI_EXTENSION_DIR)
  fsImpl.mkdirSync(destDir, { recursive: true })
  const destExtension = path.join(destDir, PI_EXTENSION_FILE)
  const destIntegrity = path.join(destDir, PI_INTEGRITY_FILE)
  const bundled = buildSync({
    entryPoints: [srcExtension], bundle: true, write: false,
    platform: "node", format: "esm", target: "node26", logLevel: "silent",
    banner: { js: 'import { createRequire as cogniaCreateRequire } from "node:module"; const require = cogniaCreateRequire(import.meta.url);' },
  }).outputFiles[0].contents
  const sha256 = createHash("sha256").update(bundled).digest("hex")
  fsImpl.writeFileSync(destExtension, bundled)
  fsImpl.writeFileSync(destIntegrity, JSON.stringify({ sha256, sourceSha256: actual }, null, 2) + "\n")

  return { sha256, dir: destDir, files: [destExtension, destIntegrity] }
}
