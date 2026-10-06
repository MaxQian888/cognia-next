import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildFrontendPlugin, writeFrontendPackage } from "./build-frontend-plugins.mjs"

test("a misspelled plugin selection fails instead of reporting an empty successful build", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./build-frontend-plugins.mjs", import.meta.url)),
          "missing-plugin-test-selection",
        ],
        { stdio: "pipe" }
      ),
    /Unknown frontend plugins: missing-plugin-test-selection/
  )
})

test("packages a source entry, named contribution and assets without modifying source", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "standalone-plugin-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = path.join(root, "plugins/example")
  await mkdir(path.join(pluginRoot, "src"), { recursive: true })
  await mkdir(path.join(pluginRoot, "assets"))
  const manifest = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    type: "frontend",
    main: "src/index.ts",
    styles: "styles.css",
    icon: "assets/icon.svg",
    capabilities: ["tools"],
  }
  const source = `export const widget = () => 42; export default { manifest: ${JSON.stringify({ ...manifest, extensions: [{ entry: "src/index.ts", export: "widget", point: "chat.input.effort" }] })}, activate() {} }`
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify(manifest))
  await writeFile(path.join(pluginRoot, "src/index.ts"), source)
  await writeFile(path.join(pluginRoot, "styles.css"), ".widget { color: red }")
  await writeFile(path.join(pluginRoot, "assets/icon.svg"), "<svg/>")
  const result = await buildFrontendPlugin({ root, directory: "example" })
  assert.equal(await readFile(path.join(pluginRoot, "src/index.ts"), "utf8"), source)
  assert.equal(result.manifest.main, "dist/index.js")
  assert.equal(result.manifest.extensions[0].entry, "dist/index.js")
  assert.equal(result.files.get("styles.css").toString(), ".widget { color: red }")
  assert.equal(result.files.get("assets/icon.svg").toString(), "<svg/>")
  const pluginModule = { exports: {} }
  new Function("module", "exports", result.files.get("dist/index.js").toString())(
    pluginModule,
    pluginModule.exports
  )
  assert.equal(pluginModule.exports.widget(), 42)
  assert.deepEqual(pluginModule.exports.default.manifest, result.manifest)
})

test("rejects escaping resource paths before producing a package", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "standalone-plugin-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = path.join(root, "plugins/example")
  await mkdir(path.join(pluginRoot, "src"), { recursive: true })
  const manifest = {
    id: "example",
    version: "1.0.0",
    type: "frontend",
    main: "src/index.ts",
    styles: "../secret.css",
  }
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify(manifest))
  await writeFile(
    path.join(pluginRoot, "src/index.ts"),
    `export default { manifest: ${JSON.stringify(manifest)}, activate() {} }`
  )
  await assert.rejects(buildFrontendPlugin({ root, directory: "example" }), /Unsafe plugin path/)
})

test("links imported CSS and combines it with authored styles in the release manifest", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "standalone-css-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = path.join(root, "plugins/example")
  await mkdir(path.join(pluginRoot, "src"), { recursive: true })
  const manifest = {
    id: "example",
    version: "1.0.0",
    type: "frontend",
    main: "src/index.ts",
    styles: "styles.css",
  }
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify(manifest))
  await writeFile(
    path.join(pluginRoot, "src/index.ts"),
    `import "./entry.css"; export default { manifest: ${JSON.stringify(manifest)}, activate() {} }`
  )
  await writeFile(path.join(pluginRoot, "src/entry.css"), ".imported { color: blue }")
  await writeFile(path.join(pluginRoot, "styles.css"), ".authored { color: red }")
  const result = await buildFrontendPlugin({ root, directory: "example", moduleManifest: manifest })
  const styles = result.files.get(result.manifest.styles).toString()
  assert.match(styles, /\.imported/)
  assert.match(styles, /\.authored/)
  const pluginModule = { exports: {} }
  new Function("module", "exports", result.files.get(result.manifest.main).toString())(
    pluginModule,
    pluginModule.exports
  )
  assert.equal(pluginModule.exports.default.manifest.styles, result.manifest.styles)
})

test("publishes executable resources and removes stale files when replacing a generated directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "standalone-publish-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = {
    manifest: { id: "example", version: "1.0.0" },
    files: new Map([
      ["bin/server.mjs", Buffer.from("#!/usr/bin/env node\n")],
      ["obsolete.txt", Buffer.from("old")],
    ]),
    fileModes: new Map([["bin/server.mjs", 0o755]]),
  }
  await writeFrontendPackage(result, root)
  result.files.delete("obsolete.txt")
  const archivePath = await writeFrontendPackage(result, root)
  await assert.rejects(stat(path.join(root, "example/obsolete.txt")), { code: "ENOENT" })
  const archive = await JSZip.loadAsync(await readFile(archivePath))
  assert.equal(Number(archive.file("bin/server.mjs").unixPermissions) & 0o777, 0o755)
  if (process.platform !== "win32")
    assert.equal((await stat(path.join(root, "example/bin/server.mjs"))).mode & 0o777, 0o755)
  await assert.rejects(
    writeFrontendPackage({ ...result, manifest: { id: "../outside", version: "1.0.0" } }, root),
    /Invalid plugin id/
  )
})

test("node runtime shipping inputs are bounded and cannot smuggle installed assets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-node-runtime-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pluginRoot = path.join(root, "plugins/example")
  await mkdir(path.join(pluginRoot, "src"), { recursive: true })
  await mkdir(path.join(pluginRoot, "runtime/node_modules"), { recursive: true })
  const manifest = {
    id: "example",
    version: "1.0.0",
    type: "frontend",
    main: "src/index.ts",
    bundle_include: ["runtime"],
    nodeRuntime: { directory: "runtime", entry: "probe.mjs" },
  }
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify(manifest))
  await writeFile(
    path.join(pluginRoot, "src/index.ts"),
    `export default {manifest:${JSON.stringify(manifest)},activate(){}}`
  )
  for (const [name, text] of Object.entries({
    "package.json": '{"private":true,"dependencies":{"@deepseek-ai/libreoffice-kit":"0.1.5"}}',
    "pnpm-lock.yaml": 'lockfileVersion: "9.0"',
    "pnpm-workspace.yaml": "packages: []",
    "probe.mjs": 'console.log("ready")',
    "node_modules/engine.wasm": "DO NOT SHIP",
    "random-engine.bin": "DO NOT SHIP",
  }))
    await writeFile(path.join(pluginRoot, "runtime", name), text)
  const built = await buildFrontendPlugin({ root, directory: "example" })
  assert.deepEqual([...built.files.keys()].filter((name) => name.startsWith("runtime/")).sort(), [
    "runtime/package.json",
    "runtime/pnpm-lock.yaml",
    "runtime/pnpm-workspace.yaml",
    "runtime/probe.mjs",
  ])
  assert.ok(!built.files.get("dist/index.js").toString().includes("DO NOT SHIP"))
  assert.ok(built.inputs.includes(path.join(pluginRoot, "runtime/pnpm-lock.yaml")))
  await writeFile(path.join(pluginRoot, "runtime/probe.mjs"), "x".repeat(1024 * 1024))
  await assert.rejects(
    buildFrontendPlugin({ root, directory: "example" }),
    /nodeRuntime sources exceed/
  )
})

test("node runtime source collection rejects traversal and symlinked files or directories", async (t) => {
  const { collectNodeRuntimeSources } = await import("./build-frontend-plugins.mjs")
  const { symlink } = await import("node:fs/promises")
  const root = await mkdtemp(path.join(tmpdir(), "plugin-node-runtime-paths-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "runtime"))
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "probe.mjs"])
    await writeFile(path.join(root, "runtime", name), "safe")
  for (const declaration of [
    { directory: "../outside", entry: "probe.mjs" },
    { directory: "runtime", entry: "../probe.mjs" },
    { directory: "runtime", entry: "node_modules/probe.mjs" },
    { directory: "runtime", entry: "probe.ts" },
  ])
    await assert.rejects(collectNodeRuntimeSources(root, declaration), /Unsafe|JavaScript/)
  await rm(path.join(root, "runtime/probe.mjs"))
  await symlink(path.join(root, "runtime/package.json"), path.join(root, "runtime/probe.mjs"))
  await assert.rejects(
    collectNodeRuntimeSources(root, { directory: "runtime", entry: "probe.mjs" }),
    /symlink/
  )
  await symlink(path.join(root, "runtime"), path.join(root, "linked-runtime"))
  await assert.rejects(
    collectNodeRuntimeSources(root, { directory: "linked-runtime", entry: "probe.mjs" }),
    /symlink/
  )
})
