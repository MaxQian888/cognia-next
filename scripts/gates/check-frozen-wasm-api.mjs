#!/usr/bin/env node
/**
 * Verify the frozen WASM plugin host API sources have not changed.
 *
 * `crates/cognia-plugin-runtime/frozen/v0_1/` holds the `cognia:plugin@0.1.0`
 * contract and its linker exactly as they shipped. v0.2.0 was a hard cutover:
 * the host registers no v0.1 linker, so those files are historical artifacts
 * that are never compiled and must never change. This gate is what makes
 * "frozen" mechanically true rather than a comment.
 *
 * Checked in THREE directions, because each catches a different mistake:
 *
 *   1. every manifest entry matches on disk (sha256 + byte length)
 *      -> catches an edit
 *   2. every file under `root` appears in the manifest
 *      -> catches dropping a new file into the frozen dir to slip it past review
 *   3. every manifest entry exists on disk
 *      -> catches a deletion, which is drift too
 *
 * Regenerate the manifest ONLY when intentionally re-freezing (for example,
 * adding a `v0_2/` sibling when v0.3 lands): `pnpm freeze:wasm-api`.
 *
 * Exported helpers are pure so `check-frozen-wasm-api.test.mjs` can drive every
 * failure mode with injected fakes.
 */

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, posix, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "../..")

export const MANIFEST_PATH = resolve(__dirname, "frozen-wasm-api.json")

/** sha256 of a buffer or string, lowercase hex. */
export function digest(buf) {
  return createHash("sha256").update(buf).digest("hex")
}

export async function readManifest(path = MANIFEST_PATH) {
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed.root !== "string" || !Array.isArray(parsed.files)) {
    throw new Error(`[check-frozen-wasm-api] malformed manifest at ${path}`)
  }
  return parsed
}

/** Recursively list files under `dir`, returned as posix-style relative paths. */
export async function listFilesRecursive(dir) {
  const out = []
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  await walk(dir, "")
  return out.sort()
}

/**
 * Compare a manifest against the filesystem.
 *
 * @param {object} args
 * @param {{root: string, files: Array<{path: string, sha256: string, bytes: number}>}} args.manifest
 * @param {() => Promise<string[]>} args.listFiles  posix-relative paths under root
 * @param {(relPath: string) => Promise<Buffer|string>} args.readFile
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function auditFrozen({ manifest, listFiles, readFile: read }) {
  const problems = []
  const listed = new Set(manifest.files.map((f) => f.path))

  // Direction 1 + 3: manifest entries must exist and match.
  for (const entry of manifest.files) {
    let content
    try {
      content = await read(entry.path)
    } catch {
      problems.push(`missing from disk: ${entry.path} (manifest expects ${entry.bytes} bytes)`)
      continue
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (buf.length !== entry.bytes) {
      problems.push(
        `size changed: ${entry.path} — expected ${entry.bytes} bytes, found ${buf.length}`
      )
    }
    const actual = digest(buf)
    if (actual !== entry.sha256) {
      problems.push(
        `content changed: ${entry.path}\n    expected sha256 ${entry.sha256}\n    actual   sha256 ${actual}`
      )
    }
  }

  // Direction 2: nothing on disk may be absent from the manifest.
  let onDisk
  try {
    onDisk = await listFiles()
  } catch (err) {
    problems.push(
      `cannot list ${manifest.root}: ${err instanceof Error ? err.message : String(err)}`
    )
    onDisk = []
  }
  for (const relPath of onDisk) {
    if (!listed.has(relPath)) {
      problems.push(
        `unlisted file present: ${relPath} — nothing may be added to a frozen directory`
      )
    }
  }

  return { ok: problems.length === 0, problems }
}

async function main() {
  const manifest = await readManifest()
  const rootAbs = resolve(repoRoot, manifest.root)

  const { ok, problems } = await auditFrozen({
    manifest,
    listFiles: () => listFilesRecursive(rootAbs),
    readFile: (relPath) => readFile(resolve(rootAbs, relPath)),
  })

  if (ok) {
    console.log(
      `[check-frozen-wasm-api] ok: ${manifest.files.length} frozen file(s) unchanged in ${manifest.root}`
    )
    return
  }

  console.error(`[check-frozen-wasm-api] FROZEN API DRIFT in ${relative(repoRoot, rootAbs)}:`)
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  console.error("")
  console.error("The v0.1 WASM plugin contract is frozen. If you are changing it, you are")
  console.error("doing it wrong — add `src/wasm/wit/since_v0_3.rs` and register it in")
  console.error("`wit/mod.rs` + `WasmPluginHost::version_linker` instead.")
  console.error("")
  console.error("If you are intentionally re-freezing, run `pnpm freeze:wasm-api` and say")
  console.error("why in the commit message.")
  process.exit(1)
}

// Only run when invoked directly, so the test file can import the helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`[check-frozen-wasm-api] failed:`, err)
    process.exit(1)
  })
}
