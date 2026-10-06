import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  REPO_ROOT,
  SHARED_MODULES_SOURCE,
  ESBUILD_EXTERNALS_SOURCE,
  BUILD_SCRIPT_SURFACES,
  NO_BUILD_SCRIPT_SURFACES,
  NO_PACKAGE_JSON_SURFACES,
  SDK_SUBPATH_WILDCARD,
  bundlerExternalsFor,
  findExternalsDrift,
  readEsbuildExternals,
  readSharedModules,
  readSurfaceExternals,
} from "./lib/plugin-externals.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "plugin-externals-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of [
    SHARED_MODULES_SOURCE,
    ESBUILD_EXTERNALS_SOURCE,
    ...BUILD_SCRIPT_SURFACES.map((surface) => surface.path),
    ...NO_BUILD_SCRIPT_SURFACES,
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), readFileSync(join(REPO_ROOT, path)))
  }
  return {
    root,
    replace(path, before, after) {
      const file = join(root, path)
      const source = readFileSync(file, "utf8")
      assert.ok(source.includes(before), `fixture must contain ${before}`)
      writeFileSync(file, source.replace(before, after))
    },
  }
}

test("current general-purpose build owners agree with the host whitelist", () => {
  assert.deepEqual(findExternalsDrift(), [])
  assert.ok(readSharedModules().includes("react"))
  assert.ok(readEsbuildExternals().includes(SDK_SUBPATH_WILDCARD))
  for (const surface of BUILD_SCRIPT_SURFACES) {
    const externals = readSurfaceExternals(surface)
    assert.ok(externals.includes("react"), `${surface.path} parsed no React external`)
    assert.ok(externals.includes(SDK_SUBPATH_WILDCARD), `${surface.path} drops SDK subpaths`)
    assert.ok(
      !externals.includes("react-dom"),
      `${surface.path} exposes an unsupported host module`
    )
  }
  assert.ok(readEsbuildExternals().includes("react-dom"))
  assert.ok(!readSharedModules().includes("react-dom"))
})

test("named SDK subpaths fold into one wildcard, including future subpaths", () => {
  assert.deepEqual(
    bundlerExternalsFor([
      "react",
      "@cognia/plugin-sdk",
      "@cognia/plugin-sdk/api/a",
      "@cognia/plugin-sdk/api/b",
    ]),
    ["react", "@cognia/plugin-sdk", SDK_SUBPATH_WILDCARD]
  )
  assert.deepEqual(bundlerExternalsFor(["react", "@cognia/plugin-sdk"]), [
    "react",
    "@cognia/plugin-sdk",
    SDK_SUBPATH_WILDCARD,
  ])
})

test("rejects host-private and other extra externals in the Rust CLI", (t) => {
  const f = fixture(t)
  f.replace(ESBUILD_EXTERNALS_SOURCE, '"react-dom",', '"react-dom", "@/lib/*", "unknown-package",')
  assert.match(findExternalsDrift(f.root).join("\n"), /extra: @\/lib\/\*, unknown-package/)
})

test("detects missing template externals and shell-quoted wildcard flags", (t) => {
  const f = fixture(t)
  const surface = BUILD_SCRIPT_SURFACES[0]
  assert.ok(readSurfaceExternals(surface, f.root).includes(SDK_SUBPATH_WILDCARD))
  f.replace(surface.path, "--external:lucide-react", "")
  assert.match(findExternalsDrift(f.root).join("\n"), /missing: lucide-react/)
})

test("checks the distribution builder's actual external expression, not only its constant", (t) => {
  const f = fixture(t)
  f.replace(
    BUILD_SCRIPT_SURFACES[1].path,
    'external: [...SHARED_MODULES, "@cognia/plugin-sdk/*"]',
    "external: [...SHARED_MODULES]"
  )
  assert.match(findExternalsDrift(f.root).join("\n"), /missing: @cognia\/plugin-sdk\/\*/)
})

test("detects duplicate entries instead of silently collapsing them", (t) => {
  const f = fixture(t)
  f.replace(ESBUILD_EXTERNALS_SOURCE, '"react-dom",', '"react-dom", "react-dom",')
  assert.match(findExternalsDrift(f.root).join("\n"), /duplicate: react-dom/)
})

test("fails closed for renamed declarations and unsupported dynamic externals", (t) => {
  const f = fixture(t)
  f.replace(BUILD_SCRIPT_SURFACES[1].path, "...SHARED_MODULES", "...OTHER_MODULES")
  assert.throws(() => findExternalsDrift(f.root), /unsupported external expression/)
  f.replace(SHARED_MODULES_SOURCE, "PLUGIN_SHARED_MODULES = [", "RENAMED_MODULES = [")
  assert.throws(() => findExternalsDrift(f.root), /parser is stale/)
})

test("new template build owners require explicit enrollment", (t) => {
  const f = fixture(t)
  const vscode = join(f.root, NO_BUILD_SCRIPT_SURFACES[0])
  const manifest = JSON.parse(readFileSync(vscode, "utf8"))
  manifest.scripts = { build: "esbuild entry.ts" }
  writeFileSync(vscode, JSON.stringify(manifest))
  const hybrid = join(f.root, NO_PACKAGE_JSON_SURFACES[0], "package.json")
  mkdirSync(dirname(hybrid), { recursive: true })
  writeFileSync(hybrid, "{}")
  const problems = findExternalsDrift(f.root).join("\n")
  assert.match(problems, /gained a build script/)
  assert.match(problems, /gained package.json/)
})
