import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { bundle, ENTRY, OUTFILE, parseArgs } from "./build-convert-bundle.mjs"

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("the checked-in bundle matches a fresh build of lib/plugin/convert", async () => {
  const fresh = await bundle()
  const committed = readFileSync(OUTFILE, "utf8")
  assert.equal(
    committed,
    fresh,
    "crates/cognia-cli/assets/plugin-convert.cjs is stale — run `pnpm plugin-convert:bundle` and commit the result"
  )
})

test("the bundle is embedded where the Rust CLI expects it", () => {
  assert.match(OUTFILE, /crates\/cognia-cli\/assets\/plugin-convert\.cjs$/)
  assert.match(ENTRY, /lib\/plugin\/convert\/bin\.ts$/)
})

test("the bundle is self-contained CommonJS a bare node can run", () => {
  const text = readFileSync(OUTFILE, "utf8")
  assert.match(text, /GENERATED FILE — do not edit/)
  // gray-matter is CommonJS and requires node builtins; an ESM bundle
  // would die on `Dynamic require of "fs" is not supported`.
  assert.doesNotMatch(text, /^export \{/m)
  assert.match(text, /require\(/)
})

test("the bundle carries no Tauri or IndexedDB runtime", () => {
  const text = readFileSync(OUTFILE, "utf8")
  // These are marked external precisely because the converter never calls
  // the code paths that reach them; bundling them would drag a browser
  // database and the Tauri IPC layer into a plain Node script.
  assert.doesNotMatch(text, /@tauri-apps\/api\/core/)
  assert.doesNotMatch(text, /new Dexie\(/)
})
