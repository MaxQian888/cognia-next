import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
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

test("a standalone bundle preserves root Skill resources and removes dotenv credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-converter-"))
  try {
    const executable = join(root, "converter.cjs")
    writeFileSync(executable, readFileSync(OUTFILE))
    const source = join(root, "source")
    mkdirSync(join(source, "references"), { recursive: true })
    mkdirSync(join(source, "assets"), { recursive: true })
    writeFileSync(
      join(source, "kimi.plugin.json"),
      JSON.stringify({ name: "resource-test", version: "1.0.0" })
    )
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: resource-test\ndescription: Inspect resources\n---\nRead references/data.md and assets/icon.png.\n"
    )
    writeFileSync(join(source, "references/data.md"), "Synthetic resource text")
    const bytes = Buffer.from([0, 255, 127, 12, 0])
    writeFileSync(join(source, "assets/icon.png"), bytes)
    writeFileSync(join(source, ".env"), "API_KEY=synthetic-secret-not-real")
    const run = (args) => {
      const result = spawnSync(process.execPath, [executable, ...args], {
        cwd: root,
        encoding: "utf8",
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      return JSON.parse(result.stdout)
    }
    const canonical = join(root, "canonical")
    run(["--from", "plugin", "--input", source, "--dir", canonical, "--accept-warnings"])
    assert.equal(readFileSync(join(canonical, ".env"), "utf8").trim(), "")
    assert.deepEqual(readFileSync(join(canonical, "assets/icon.png")), bytes)
    const target = join(root, "claude")
    const exported = run([
      "--operation",
      "export",
      "--input",
      canonical,
      "--to",
      "claude-code",
      "--dir",
      target,
      "--accept-warnings",
    ])
    assert.deepEqual(readFileSync(join(target, "skills/resource-test/assets/icon.png")), bytes)
    assert.equal(
      readFileSync(join(target, "skills/resource-test/references/data.md"), "utf8"),
      "Synthetic resource text"
    )
    assert.equal(existsSync(join(target, ".env")), false)
    assert.equal(existsSync(join(target, "skills/resource-test/.env")), false)
    assert.equal(exported.report.delivery.hostVerified, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
