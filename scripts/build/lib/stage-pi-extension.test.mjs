import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  PI_EXTENSION_FILE,
  PI_INTEGRITY_FILE,
  stagePiExtension,
} from "./stage-pi-extension.mjs"

const SOURCE = "export const cognia = 1\n"
const DIGEST = createHash("sha256").update(SOURCE).digest("hex")

test("standalone packaged extension loads its MCP and PII dependencies without node_modules", (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const out = mkdtempSync(join(tmpdir(), "cognia-pi-standalone-"))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  const staged = stagePiExtension({ root, sidecarOutDir: join(out, "sidecar") })
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const extension = await import(${JSON.stringify(staged.files[0])}); if(typeof extension.createMcpProjection !== 'function') throw new Error('missing MCP projection');`], { cwd: out, encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(!existsSync(join(out, "node_modules")))
})

test("desktop resource bundle includes the raw extension's declared runtime dependencies", () => {
  const config = JSON.parse(readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  const resources = JSON.stringify(config.bundle.resources)
  assert.match(resources, /sidecar\/pi-extension/)
  assert.match(resources, /sidecar\/node_modules/)
  const pkg = JSON.parse(readFileSync(new URL("../../../sidecar/package.json", import.meta.url), "utf8"))
  assert.ok(pkg.dependencies["@modelcontextprotocol/sdk"])
  assert.ok(pkg.dependencies["@cognia/redact"])
})

/** A throwaway repo root with `sidecar/pi-extension/` populated. */
function makeRoot({ source = SOURCE, manifest = { sha256: DIGEST } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stage-pi-extension-"))
  const dir = join(root, "sidecar", "pi-extension")
  mkdirSync(dir, { recursive: true })
  if (source !== null) writeFileSync(join(dir, PI_EXTENSION_FILE), source)
  if (manifest !== null) writeFileSync(join(dir, PI_INTEGRITY_FILE), JSON.stringify(manifest))
  return root
}

test("stages both files under pi-extension/ and reports the digest", () => {
  const root = makeRoot()
  const out = join(root, "out", "sidecar")
  const result = stagePiExtension({ root, sidecarOutDir: out })

  const staged = join(out, "pi-extension", PI_EXTENSION_FILE)
  const stagedManifest = join(out, "pi-extension", PI_INTEGRITY_FILE)
  assert.match(readFileSync(staged, "utf8"), /cognia = 1/)
  const compiledDigest = createHash("sha256").update(readFileSync(staged)).digest("hex")
  assert.equal(JSON.parse(readFileSync(stagedManifest, "utf8")).sha256, compiledDigest)
  assert.equal(JSON.parse(readFileSync(stagedManifest, "utf8")).sourceSha256, DIGEST)
  assert.equal(result.sha256, compiledDigest)
  assert.deepEqual(result.files, [staged, stagedManifest])
})

// The relative shape is the contract: `resolvePiExtensionScript` looks for
// exactly `sidecar/pi-extension/cognia-pi-extension.ts` next to the bundle, and
// `verifyPiExtension` finds the manifest by stripping that same suffix. A flat
// copy (the shape the sibling SIDECAR_DATA_FILES loop uses) resolves to
// nothing, and the host reports the extension as missing.
test("keeps the pi-extension/ subdirectory rather than flattening", () => {
  const root = makeRoot()
  const out = join(root, "out", "sidecar")
  stagePiExtension({ root, sidecarOutDir: out })
  assert.ok(!existsSync(join(out, PI_EXTENSION_FILE)), "must not be flattened into the sidecar root")
  assert.ok(existsSync(join(out, "pi-extension", PI_EXTENSION_FILE)))
})

test("refuses a missing extension", () => {
  const root = makeRoot({ source: null })
  assert.throws(
    () => stagePiExtension({ root, sidecarOutDir: join(root, "out") }),
    /missing .*cognia-pi-extension\.ts/
  )
})

test("refuses a missing integrity manifest", () => {
  const root = makeRoot({ manifest: null })
  assert.throws(
    () => stagePiExtension({ root, sidecarOutDir: join(root, "out") }),
    /missing .*integrity\.json/
  )
})

test("refuses a manifest with no sha256", () => {
  const root = makeRoot({ manifest: { note: "nothing pinned here" } })
  assert.throws(
    () => stagePiExtension({ root, sidecarOutDir: join(root, "out") }),
    /has no `sha256`/
  )
})

test("refuses unreadable manifest JSON", () => {
  const root = makeRoot()
  writeFileSync(join(root, "sidecar", "pi-extension", PI_INTEGRITY_FILE), "{ not json")
  assert.throws(
    () => stagePiExtension({ root, sidecarOutDir: join(root, "out") }),
    /not readable JSON/
  )
})

// A stale pin caught here is a forgotten re-pin; the same pin shipped is an
// image where every Pi session refuses and only a new release fixes it.
test("refuses a digest that does not match the pin, and stages nothing", () => {
  const root = makeRoot({ source: "export const tampered = 1\n" })
  const out = join(root, "out", "sidecar")
  assert.throws(
    () => stagePiExtension({ root, sidecarOutDir: out }),
    /does not match its pinned digest/
  )
  assert.ok(!existsSync(join(out, "pi-extension", PI_EXTENSION_FILE)))
})

test("compares the pin case-insensitively", () => {
  const root = makeRoot({ manifest: { sha256: DIGEST.toUpperCase() } })
  const out = join(root, "out", "sidecar")
  stagePiExtension({ root, sidecarOutDir: out })
  assert.equal(JSON.parse(readFileSync(join(out, "pi-extension", PI_INTEGRITY_FILE), "utf8")).sourceSha256, DIGEST)
})

test("requires root and sidecarOutDir", () => {
  assert.throws(() => stagePiExtension({ sidecarOutDir: "/tmp/x" }), /`root` is required/)
  assert.throws(() => stagePiExtension({ root: "/tmp/x" }), /`sidecarOutDir` is required/)
})

// The bug this helper exists to fix was a drift: the resolver looked for one
// relative path and the pkg layout shipped nothing there. Read the resolver's
// own literals back and assert the staged shape still satisfies them, so a
// rename on either side fails here instead of at a user's first Pi session.
test("stages the exact relative path the CLI resolver looks for", () => {
  const resolver = readFileSync(
    new URL("../../../cli/src/agent/tool-host/pi-extension.ts", import.meta.url),
    "utf8"
  )
  const literals = (name) => {
    const match = resolver.match(
      new RegExp(`const ${name} = path\\.join\\(([^)]*)\\)`)
    )
    assert.ok(match, `${name} is no longer a path.join(...) literal in the resolver`)
    return match[1]
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
  }

  assert.deepEqual(literals("EXTENSION_RELATIVE"), ["sidecar", "pi-extension", PI_EXTENSION_FILE])
  assert.deepEqual(literals("INTEGRITY_RELATIVE"), ["sidecar", "pi-extension", PI_INTEGRITY_FILE])
})
