import test from "node:test"
import assert from "node:assert/strict"
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { probe, failure } from "./probe.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const request = { schemaVersion: 1, operation: "probe" }
const name = "@deepseek-ai/libreoffice-kit"

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cognia-office-probe-test-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const apiRoot = join(root, "node_modules", name)
  const backend = process.platform === "linux" ? "wasm" : "native"
  const target = backend === "wasm" ? "wasm" : `${process.platform}-${process.arch}`
  const engineName = `${name}-${target}`
  // An actual nested dependency proves resolution does not assume npm hoisting.
  const engineRoot = join(apiRoot, "node_modules", engineName)
  await mkdir(engineRoot, { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await copyFile(join(here, "probe.mjs"), join(root, "probe.mjs"))
  await writeFile(
    join(apiRoot, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.5",
      type: "module",
      main: "index.js",
      optionalDependencies: { [engineName]: "0.1.5" },
    })
  )
  await writeFile(
    join(engineRoot, "package.json"),
    JSON.stringify({ name: engineName, version: "0.1.5" })
  )
  const marker = join(root, "module-loaded")
  await writeFile(
    join(apiRoot, "index.js"),
    `
    import { writeFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    writeFileSync(${JSON.stringify(marker)}, 'loaded');
    export const ENGINE_VERSION = '0.1.5';
    export const ENGINE_VERSIONS = ${JSON.stringify({ [target]: "0.1.5" })};
    export const discoverRuntime = async () => ({version:'0.1.5',backend:${JSON.stringify(backend)},nodeApiPath:fileURLToPath(import.meta.url),cliPath:fileURLToPath(new URL('./cli.js',import.meta.url))});
    export const createConverter = () => { throw new Error('A discovery probe must never create a converter'); };
  `
  )
  await writeFile(
    join(apiRoot, "cli.js"),
    "throw new Error('A discovery probe must never invoke CLI')"
  )
  const engine =
    backend === "native"
      ? { kind: backend, executable: "bin/engine", programDirectory: "program" }
      : {
          kind: backend,
          loader: "loader.js",
          wasm: "engine.wasm",
          data: "engine.data",
          metadata: "engine.json",
          programDirectory: "/instdir/program",
        }
  if (backend === "native") {
    await mkdir(join(engineRoot, "bin"))
    await mkdir(join(engineRoot, "program"))
    await writeFile(join(engineRoot, "bin/engine"), "not executed")
    await chmod(join(engineRoot, "bin/engine"), 0o755)
  } else {
    for (const path of ["loader.js", "engine.wasm", "engine.data", "engine.json"])
      await writeFile(join(engineRoot, path), "not executed")
  }
  const manifest = { schemaVersion: 1, version: "0.1.5", platform: target, status: "built", engine }
  await writeFile(join(engineRoot, "prebuilds.json"), JSON.stringify(manifest))
  return { root, marker, apiRoot, engineRoot, backend, manifest }
}

test("importing the probe does not eagerly load Office and invalid requests cannot load it", async (t) => {
  const f = await fixture(t)
  const probeModule = await import(pathToFileURL(join(f.root, "probe.mjs")))
  await assert.rejects(() => access(f.marker), { code: "ENOENT" })
  await assert.rejects(
    () => probeModule.probe({ ...request, operation: "render", inputPath: "/private.docx" }),
    { code: "invalid-arguments" }
  )
  await assert.rejects(() => access(f.marker), { code: "ENOENT" })
})

test("explicit discovery loads only the installed API and returns verified nested engine paths", async (t) => {
  const f = await fixture(t)
  const result = await probe(request, { root: f.root })
  assert.equal(result.apiVersion, "0.1.5")
  assert.equal(result.engineVersion, "0.1.5")
  assert.equal(result.backend, f.backend)
  assert.equal(result.packageRoot, f.apiRoot)
  assert.equal(result.engineRoot, f.engineRoot)
  assert.equal(result.documentsSupported, false)
  assert.equal(await readFile(f.marker, "utf8"), "loaded")
  const realAsset = result.enginePaths.executable ?? result.enginePaths.wasm
  assert.equal(await realpath(realAsset), realAsset)
})

test("missing install, incompatible Node and unrequested path fields fail closed", async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => probe(request, { root: f.root, nodeVersion: "22.18.0" }), {
    code: "unsupported-runtime",
  })
  await assert.rejects(() => probe({ ...request, root: f.root }, { root: f.root }), {
    code: "invalid-arguments",
  })
  await rm(join(f.root, "node_modules"), { recursive: true })
  await assert.rejects(() => probe(request, { root: f.root }))
  assert.equal(
    failure({ code: "MODULE_NOT_FOUND", message: "not installed" }).error.code,
    "unavailable"
  )
})

test("rejects wrong engine version and asset traversal", async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.engineRoot, "prebuilds.json"),
    JSON.stringify({ ...f.manifest, version: "0.1.3" })
  )
  await assert.rejects(() => probe(request, { root: f.root }), /incompatible or incomplete/)
  const field = f.backend === "native" ? "executable" : "wasm"
  await writeFile(
    join(f.engineRoot, "prebuilds.json"),
    JSON.stringify({ ...f.manifest, engine: { ...f.manifest.engine, [field]: "../../escape" } })
  )
  await assert.rejects(() => probe(request, { root: f.root }), /escapes/)
})

test("rejects engine asset symlinks outside the pinned package", async (t) => {
  const f = await fixture(t)
  const outside = join(f.root, "unowned-engine")
  await writeFile(outside, "never executed")
  const field = f.backend === "native" ? "executable" : "wasm"
  const asset = join(f.engineRoot, f.manifest.engine[field])
  await rm(asset)
  await symlink(outside, asset)
  await assert.rejects(() => probe(request, { root: f.root }), /link escapes/)
})

test("stdio accepts one explicit JSON probe and rejects conversion, malformed and oversized input", async (t) => {
  const f = await fixture(t)
  for (const input of [
    JSON.stringify({ ...request, operation: "convert" }),
    "bad json",
    " ".repeat(4097),
  ]) {
    const processResult = spawnSync(process.execPath, [join(f.root, "probe.mjs")], {
      input,
      encoding: "utf8",
    })
    assert.equal(processResult.status, 1)
    assert.equal(JSON.parse(processResult.stdout).error.code, "invalid-arguments")
  }
  await assert.rejects(() => access(f.marker), { code: "ENOENT" })
  const processResult = spawnSync(process.execPath, [join(f.root, "probe.mjs")], {
    input: JSON.stringify(request),
    encoding: "utf8",
  })
  assert.equal(processResult.status, 0, processResult.stderr)
  assert.equal(JSON.parse(processResult.stdout).result.documentsSupported, false)
})

test("shipped package manifest pins the runtime without test/build lifecycle or test assets", async () => {
  const manifest = JSON.parse(await readFile(join(here, "package.json"), "utf8"))
  assert.equal(manifest.dependencies[name], "0.1.5")
  assert.equal(manifest.packageManager, "pnpm@11.18.0")
  assert.equal(manifest.scripts, undefined)
  assert.ok(!manifest.files.includes("probe.test.mjs"))
  const policy = await readFile(resolve(here, "pnpm-workspace.yaml"), "utf8")
  assert.match(policy, /minimumReleaseAge: 1440/)
  assert.match(policy, /"koffi@3\.1\.1": false/)
  assert.doesNotMatch(policy, /minimumReleaseAgeExclude/)
})

test("stdio entry works through a directory alias such as macOS /tmp", async (t) => {
  const f = await fixture(t)
  const alias = join(f.root, "directory-alias")
  await symlink(f.root, alias, "dir")
  const result = spawnSync(process.execPath, [join(alias, "probe.mjs")], {
    input: JSON.stringify(request),
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result.engineVersion, "0.1.5")
})
