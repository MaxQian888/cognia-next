import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { copyRuntimeClosure, findInstalledPackage } from "./copy-runtime-closure.mjs"

function pkg(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, "index.js"), `module.exports = ${JSON.stringify(manifest.name)}`)
}

/** A pnpm-shaped store: each package's deps are siblings in its virtual-store dir. */
function pnpmTree(root) {
  const store = path.join(root, "node_modules", ".pnpm")
  const sdkHome = path.join(store, "sdk@1", "node_modules")
  pkg(path.join(sdkHome, "sdk"), {
    name: "sdk",
    version: "1.0.0",
    dependencies: { helper: "^2" },
    peerDependencies: { mcp: "^1", zod: "^4", absent: "^1" },
    peerDependenciesMeta: { absent: { optional: true } },
    optionalDependencies: { "sdk-darwin-arm64": "1.0.0" },
  })
  pkg(path.join(sdkHome, "helper"), { name: "helper", version: "2.0.0", dependencies: { zod: "^3" } })
  pkg(path.join(sdkHome, "mcp"), { name: "mcp", version: "1.2.0", dependencies: { zod: "^4" } })
  pkg(path.join(sdkHome, "zod"), { name: "zod", version: "4.1.0" })
  pkg(path.join(sdkHome, "sdk-darwin-arm64"), { name: "sdk-darwin-arm64", version: "1.0.0" })
  // helper's own zod@3 lives in helper's virtual-store dir.
  pkg(path.join(store, "helper@2", "node_modules", "zod"), { name: "zod", version: "3.9.0" })
  fs.rmSync(path.join(sdkHome, "helper"), { recursive: true })
  pkg(path.join(store, "helper@2", "node_modules", "helper"), {
    name: "helper",
    version: "2.0.0",
    dependencies: { zod: "^3" },
  })
  fs.symlinkSync(path.join(store, "helper@2", "node_modules", "helper"), path.join(sdkHome, "helper"), "dir")
  fs.symlinkSync(path.join(sdkHome, "sdk"), path.join(root, "node_modules", "sdk"), "dir")
}

test("copies a package with its dependencies and peers, flat, nesting only a conflicting version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-closure-"))
  try {
    pnpmTree(root)
    const dest = path.join(root, "out", "node_modules")
    const copied = copyRuntimeClosure({ names: ["sdk"], fromDir: root, destNodeModules: dest })
    assert.deepEqual([...copied.keys()].sort(), ["helper@2.0.0", "mcp@1.2.0", "sdk@1.0.0", "zod@3.9.0", "zod@4.1.0"])
    for (const name of ["sdk", "helper", "mcp"]) {
      assert.ok(fs.existsSync(path.join(dest, name, "package.json")), name)
      assert.ok(!fs.lstatSync(path.join(dest, name)).isSymbolicLink(), `${name} is a real directory`)
    }
    // The peers the SDK needs sit beside it: zod@4 flat, helper's zod@3 nested.
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, "zod", "package.json"), "utf8")).version, "4.1.0")
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dest, "helper", "node_modules", "zod", "package.json"), "utf8")).version,
      "3.9.0"
    )
    // Optional dependencies and optional peers are not pulled in.
    assert.ok(!fs.existsSync(path.join(dest, "sdk-darwin-arm64")))
    assert.ok(!fs.existsSync(path.join(dest, "absent")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a second closure into the same tree keeps the first one's flat packages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-closure-"))
  try {
    pnpmTree(root)
    const other = path.join(root, "other")
    pkg(path.join(other, "node_modules", "parser"), { name: "parser", version: "1.0.0", dependencies: { zod: "^3" } })
    pkg(path.join(other, "node_modules", "zod"), { name: "zod", version: "3.1.0" })
    const dest = path.join(root, "out", "node_modules")
    copyRuntimeClosure({ names: ["sdk"], fromDir: root, destNodeModules: dest })
    copyRuntimeClosure({ names: ["parser"], fromDir: other, destNodeModules: dest })
    assert.equal(JSON.parse(fs.readFileSync(path.join(dest, "zod", "package.json"), "utf8")).version, "4.1.0")
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dest, "parser", "node_modules", "zod", "package.json"), "utf8")).version,
      "3.1.0"
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a missing required dependency names who needed it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-closure-"))
  try {
    pkg(path.join(root, "node_modules", "lonely"), { name: "lonely", version: "1.0.0", peerDependencies: { gone: "^1" } })
    assert.throws(
      () => copyRuntimeClosure({ names: ["lonely"], fromDir: root, destNodeModules: path.join(root, "out") }),
      /runtime dependency gone of lonely@1\.0\.0 is not installed/
    )
    assert.equal(findInstalledPackage("gone", root), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const versionIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version

test("every dependent of a nested version gets its own copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-closure-"))
  try {
    pnpmTree(root)
    // `other` needs the same zod@3 as helper, while zod@4 holds the flat slot.
    pkg(path.join(root, "node_modules", "other"), { name: "other", version: "1.0.0", dependencies: { zod: "^3" } })
    pkg(path.join(root, "node_modules", "other", "node_modules", "zod"), { name: "zod", version: "3.9.0" })
    const dest = path.join(root, "out", "node_modules")
    copyRuntimeClosure({ names: ["sdk", "other"], fromDir: root, destNodeModules: dest })
    assert.equal(versionIn(path.join(dest, "zod")), "4.1.0")
    assert.equal(versionIn(path.join(dest, "helper", "node_modules", "zod")), "3.9.0")
    assert.equal(versionIn(path.join(dest, "other", "node_modules", "zod")), "3.9.0")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a nested dependent is not shadowed by its parent's nested version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-closure-"))
  try {
    const modules = path.join(root, "node_modules")
    pkg(path.join(modules, "c"), { name: "c", version: "3.0.0" })
    pkg(path.join(modules, "a"), { name: "a", version: "2.0.0" })
    pkg(path.join(modules, "x"), { name: "x", version: "1.0.0", dependencies: { a: "^1", c: "^1" } })
    pkg(path.join(modules, "x", "node_modules", "c"), { name: "c", version: "1.0.0" })
    // x's a@1 needs c@3, which it finds beside itself in a store directory.
    const storeA = path.join(root, "store", "a@1", "node_modules")
    pkg(path.join(storeA, "a"), { name: "a", version: "1.0.0", dependencies: { c: "^3" } })
    pkg(path.join(storeA, "c"), { name: "c", version: "3.0.0" })
    fs.symlinkSync(path.join(storeA, "a"), path.join(modules, "x", "node_modules", "a"), "dir")
    const dest = path.join(root, "out", "node_modules")
    copyRuntimeClosure({ names: ["c", "a", "x"], fromDir: root, destNodeModules: dest })
    assert.equal(versionIn(path.join(dest, "c")), "3.0.0")
    assert.equal(versionIn(path.join(dest, "x", "node_modules", "c")), "1.0.0")
    assert.equal(versionIn(path.join(dest, "x", "node_modules", "a")), "1.0.0")
    // Node resolving c from x/node_modules/a reaches x's c@1 first, so a needs its own c@3.
    assert.equal(versionIn(path.join(dest, "x", "node_modules", "a", "node_modules", "c")), "3.0.0")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
