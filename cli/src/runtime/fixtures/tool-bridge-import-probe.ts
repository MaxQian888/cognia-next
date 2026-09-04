/**
 * Exercise {@link runToolBridgeRole}'s DEFAULT importer at a real ESM boundary.
 *
 * Jest transforms this module graph to CommonJS, which rewrites `import(url)`
 * into `require(url)`. Loading a real `.mjs` through that rewrite fails with
 * "Cannot use import statement outside a module", which says something about
 * the test transform and nothing about the shipped bundle (esbuild keeps the
 * dynamic import intact there). So the default seam is proved in a separate
 * Node process that actually has ESM.
 *
 * A dependency-free sidecar module stands in for the bridge, so the importer is
 * genuinely exercised without starting an MCP loop.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

import { runToolBridgeRole } from "../tool-bridge-role"

const here = path.dirname(fileURLToPath(import.meta.url))
const harmless = path.join(
  here,
  "..",
  "..",
  "..",
  "..",
  "sidecar",
  "builtin-tools",
  "read-only-timeout.mjs"
)

try {
  const resolved = await runToolBridgeRole({ resolveScript: () => harmless })
  process.stdout.write(JSON.stringify({ ok: true, resolved: resolved ?? null }))
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })
  )
}
