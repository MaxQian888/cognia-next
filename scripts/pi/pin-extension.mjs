#!/usr/bin/env node
/**
 * Regenerate the bundled Pi extension's integrity manifest (ADR-0119).
 *
 * The extension enforces Pi's native-tool permission matrix, so it is pinned
 * by SHA-256 and refused when the digest does not match. Any edit to
 * `cognia-pi-extension.ts` therefore has to be followed by a re-pin, or Pi
 * sessions stop starting.
 *
 * Modes:
 *   (default)  rewrite the manifest from the current file.
 *   --check    exit 1 when the manifest is stale, without writing. Used by the
 *              gates so a forgotten re-pin fails CI instead of shipping an
 *              extension that refuses to load on the user's machine.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const extension = path.join(root, "sidecar", "pi-extension", "cognia-pi-extension.ts")
const manifest = path.join(root, "sidecar", "pi-extension", "integrity.json")

const NOTE =
  "SHA-256 of cognia-pi-extension.ts. Regenerate with `pnpm pi:extension:pin` after any edit; " +
  "a stale digest refuses the extension and blocks Pi sessions."

if (!fs.existsSync(extension)) {
  console.error(`[pi:pin] missing ${path.relative(root, extension)}`)
  process.exit(1)
}

const sha256 = createHash("sha256").update(fs.readFileSync(extension)).digest("hex")
const check = process.argv.includes("--check")

if (check) {
  let pinned
  try {
    pinned = JSON.parse(fs.readFileSync(manifest, "utf8")).sha256
  } catch {
    pinned = undefined
  }
  if (pinned !== sha256) {
    console.error(
      `[pi:pin] integrity.json is stale\n  expected ${sha256}\n  found    ${pinned ?? "<none>"}\n` +
        `  run: pnpm pi:extension:pin`
    )
    process.exit(1)
  }
  console.log(`[pi:pin] OK — ${sha256}`)
  process.exit(0)
}

fs.writeFileSync(manifest, `${JSON.stringify({ "//": NOTE, sha256 }, null, 2)}\n`)
console.log(`[pi:pin] wrote ${path.relative(root, manifest)} — ${sha256}`)
