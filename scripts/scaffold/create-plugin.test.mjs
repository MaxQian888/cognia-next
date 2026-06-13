import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import {
  slugify,
  normalizeOptions,
  buildPluginFiles,
  writePluginFiles,
  SAMPLE_CONFIG_SCHEMA,
} from "./create-plugin.mjs"

test("slugify produces a clean kebab id", () => {
  assert.equal(slugify("My Cool Plugin!"), "my-cool-plugin")
  assert.equal(slugify("  spaced  out  "), "spaced-out")
  assert.equal(slugify("already-kebab"), "already-kebab")
})

test("normalizeOptions fills defaults and derives the id from the name", () => {
  const opts = normalizeOptions({ name: "Weather Bot" })
  assert.equal(opts.id, "weather-bot")
  assert.equal(opts.type, "frontend")
  assert.deepEqual(opts.capabilities, ["tools"])
  assert.equal(opts.license, "MIT")
  assert.equal(opts.configSchema, SAMPLE_CONFIG_SCHEMA)
})

test("normalizeOptions honors an explicit id, capabilities, and --no-config", () => {
  const opts = normalizeOptions({
    name: "X",
    id: "custom-id",
    capabilities: ["tools", "commands"],
    withConfig: false,
  })
  assert.equal(opts.id, "custom-id")
  assert.deepEqual(opts.capabilities, ["tools", "commands"])
  assert.equal(opts.configSchema, undefined)
})

test("normalizeOptions rejects an unknown type", () => {
  assert.throws(() => normalizeOptions({ name: "X", type: "rust" }), /unknown plugin type/)
})

test("buildPluginFiles scaffolds a frontend plugin with config codegen", () => {
  const { files } = buildPluginFiles({ name: "Weather Bot" })
  assert.deepEqual(Object.keys(files).sort(), [
    "config.generated.ts",
    "evals.harness.mjs",
    "evals.yaml",
    "plugin.json",
    "src/index.test.ts",
    "src/index.ts",
  ])
  const manifest = JSON.parse(files["plugin.json"])
  assert.equal(manifest.id, "weather-bot")
  assert.equal(manifest.type, "frontend")
  assert.equal(manifest.main, "src/index.ts")
  assert.ok(manifest.configSchema)
  assert.match(files["src/index.ts"], /definePlugin\(/)
  assert.match(files["src/index.ts"], /from "@cognia\/plugin-sdk\/manifest"/)
  assert.match(files["src/index.ts"], /from "\.\/config\.generated"/)
  assert.match(files["src/index.test.ts"], /definition\.manifest\.id\)\.toBe\("weather-bot"\)/)
  assert.match(files["config.generated.ts"], /export interface PluginConfig/)
})

test("buildPluginFiles scaffolds a runnable eval suite + harness for frontend plugins", () => {
  const { files } = buildPluginFiles({ name: "Weather Bot" })
  assert.match(files["evals.yaml"], /^evals:/m)
  assert.match(files["evals.yaml"], /callsTool: echo/)
  assert.match(files["evals.harness.mjs"], /export async function invokeTool/)
  assert.match(files["evals.harness.mjs"], /name === "echo"/)
})

test("buildPluginFiles scaffolds a python plugin", () => {
  const { files } = buildPluginFiles({ name: "Cron Helper", type: "python" })
  assert.deepEqual(Object.keys(files).sort(), [
    "config_generated.py",
    "main.py",
    "plugin.json",
    "test_main.py",
  ])
  const manifest = JSON.parse(files["plugin.json"])
  assert.equal(manifest.type, "python")
  assert.equal(manifest.pythonMain, "main.py")
  assert.deepEqual(manifest.permissions, ["python:execute"])
  assert.equal(manifest.runtimeCompatibility.browser.availability, "blocked")
  assert.match(files["main.py"], /from cognia import get_config, tool/)
  assert.match(files["main.py"], /@tool\(description=/)
  assert.match(files["test_main.py"], /call_tool\("greet"/)
})

test("buildPluginFiles can omit the config artifact", () => {
  const { files } = buildPluginFiles({ name: "Minimal", withConfig: false })
  assert.ok(!("config.generated.ts" in files))
  assert.ok(!files["src/index.ts"].includes("config.generated"))
})

test("writePluginFiles writes every file and guards against overwrite", () => {
  const written = {}
  const made = new Set()
  const deps = {
    files: { "plugin.json": "{}", "src/index.ts": "x" },
    targetDir: "/out",
    mkdir: (dir) => made.add(dir.replaceAll("\\", "/")),
    writeFile: (path, content) => {
      written[path.replaceAll("\\", "/")] = content
    },
    exists: () => false,
  }
  const paths = writePluginFiles(deps)
  assert.equal(paths.length, 2)
  assert.equal(written[join("/out", "plugin.json").replaceAll("\\", "/")], "{}")
  assert.ok(made.has("/out") || made.has("/out/src"))

  // Overwrite guard fires when a target already exists and force is off.
  assert.throws(
    () =>
      writePluginFiles({
        files: { "plugin.json": "{}" },
        targetDir: "/out",
        mkdir: () => {},
        writeFile: () => {},
        exists: () => true,
      }),
    /refusing to overwrite/
  )
})
