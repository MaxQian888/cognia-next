import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as esbuild from "esbuild"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const validatorPath = resolve(scriptsDir, "../contract/ide-manifest-validator.generated.cjs")

test("the generated IDE contract artifacts are current", () => {
  const run = spawnSync(
    process.execPath,
    [join(scriptsDir, "generate-ide-contract.mjs"), "--check"],
    {
      encoding: "utf8",
    }
  )
  assert.equal(run.status, 0, run.stderr)
})

test("the generated manifest validator requires no module", () => {
  // Ajv's standalone output reaches its runtime helpers through `require`;
  // the generator inlines them so no consumer has to resolve one.
  assert.doesNotMatch(readFileSync(validatorPath, "utf8"), /\brequire\(/)
})

test("the manifest validator runs from an ES-module bundle that keeps packages external", async () => {
  // The CLI's bundle shape (scripts/build/esbuild-shared.mjs): a bundled
  // CommonJS `require` of an external package throws `Dynamic require of …`.
  const result = await esbuild.build({
    stdin: {
      contents: `import validate from ${JSON.stringify(validatorPath)}; export default validate`,
      resolveDir: scriptsDir,
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    logLevel: "silent",
  })
  const dir = mkdtempSync(join(tmpdir(), "ide-validator-esm-"))
  try {
    const file = join(dir, "validator.mjs")
    writeFileSync(file, result.outputFiles[0].text)
    const { default: validate } = await import(pathToFileURL(file).href)
    assert.equal(validate({ bogus: true }), false)
    assert.ok(validate.errors.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
