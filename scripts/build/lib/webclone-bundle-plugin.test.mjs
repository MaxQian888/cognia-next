import assert from "node:assert/strict"
import { after, test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { build } from "esbuild"
import { createWebcloneBundlePlugin, rewriteWebcloneAnalyzer } from "./webclone-bundle-plugin.mjs"

const root = path.resolve(import.meta.dirname, "../../..")
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-webclone-bundle-"))
after(() => fs.rmSync(directory, { recursive: true, force: true }))
const analyzer = path.join(root, "sidecar/webclone/dist/transform/js-analyzer.js")
const entry = path.join(directory, "entry.mjs")
fs.writeFileSync(entry, `
import { analyzeJavaScript } from ${JSON.stringify(analyzer)};
import { parse, generate } from "css-tree";
console.log(JSON.stringify({
  analysis: analyzeJavaScript('document.querySelector("#panel");', {}),
  css: generate(parse("a { color: red }"))
}));
`)

const env = { PATH: process.env.PATH, HOME: directory, NODE_PATH: "" }
function assertAnalysis(result) {
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.analysis.todos, [])
  assert.deepEqual(output.analysis.refs, [{ selector: "#panel", method: "querySelector" }])
  assert.equal(output.css, "a{color:red}")
}

test("esbuild ships Babel traversal and CSS data without any adjacent node_modules", async () => {
  const outfile = path.join(directory, "esbuild.mjs")
  const result = await build({ entryPoints: [entry], outfile, bundle: true,
    platform: "node", target: "node26", format: "esm", metafile: true,
    plugins: [createWebcloneBundlePlugin({ root })],
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
  })
  assert.ok(Object.keys(result.metafile.inputs).some((name) => name.includes("@babel/traverse")))
  assertAnalysis(spawnSync(process.execPath, [outfile], { cwd: directory, env, encoding: "utf8" }))
})

test("Bun uses the same dependency closure and Babel 8 traversal binding", () => {
  const runner = path.join(directory, "bun-build.mjs")
  const outfile = path.join(directory, "bun-output", "entry.js")
  fs.writeFileSync(runner, `
import {createWebcloneBundlePlugin} from ${JSON.stringify(path.join(root, "scripts/build/lib/webclone-bundle-plugin.mjs"))};
const result = await Bun.build({ entrypoints: [${JSON.stringify(entry)}],
  outdir: ${JSON.stringify(path.dirname(outfile))}, target: "bun", format: "esm",
  plugins: [createWebcloneBundlePlugin({ root: ${JSON.stringify(root)} })] });
if (!result.success) { console.error(result.logs); process.exit(1); }
`)
  const buildResult = spawnSync("bun", [runner], { cwd: directory, env, encoding: "utf8" })
  assert.equal(buildResult.status, 0, buildResult.stderr)
  assertAnalysis(spawnSync("bun", [outfile], { cwd: directory, env, encoding: "utf8" }))
})

test("source drift and newly introduced dynamic dependencies fail at build time", () => {
  const source = fs.readFileSync(analyzer, "utf8")
  assert.doesNotThrow(() => rewriteWebcloneAnalyzer(source.replaceAll("\n", "\r\n")))
  assert.throws(() => rewriteWebcloneAnalyzer(source.replace("const traverse =", "const visitor =")), /binding changed/u)
  assert.throws(() => rewriteWebcloneAnalyzer(source + '\nrequire("new-hidden-package");'), /unbundled runtime require/u)
})
