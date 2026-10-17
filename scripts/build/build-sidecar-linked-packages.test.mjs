import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { test } from "node:test"
import ts from "typescript"

import {
  collectSidecarCogniaSpecifiers,
  linkedPackageDirs,
  materializeLinkedPackages,
  resolveFromSidecar,
  runtimeCogniaSpecifiers,
  sidecarRoot,
  unshippableResolutions,
} from "./build-sidecar-linked-packages.mjs"

test("materializeLinkedPackages replaces workspace links without copying development dependencies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cognia-linked-staging-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, "packages", "redact")
  const sidecar = join(root, "sidecar")
  const destination = join(sidecar, "node_modules", "@cognia", "redact")
  mkdirSync(join(source, "dist"), { recursive: true })
  mkdirSync(join(source, "node_modules", "development-only"), { recursive: true })
  mkdirSync(join(sidecar, "node_modules", "@cognia"), { recursive: true })
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@cognia/redact" }))
  writeFileSync(join(source, "dist", "index.js"), "export const version = 1")
  writeFileSync(join(source, "node_modules", "development-only", "index.js"), "unused")
  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir")

  const packages = [{ name: "@cognia/redact", dir: source }]
  materializeLinkedPackages(packages, sidecar)
  assert.equal(lstatSync(destination).isSymbolicLink(), false)
  assert.equal(existsSync(join(destination, "node_modules")), false)
  assert.equal(readFileSync(join(destination, "dist", "index.js"), "utf8"), "export const version = 1")
  assert.equal(existsSync(join(source, "node_modules", "development-only", "index.js")), true)

  writeFileSync(join(source, "dist", "index.js"), "export const version = 2")
  materializeLinkedPackages(packages, sidecar)
  assert.equal(readFileSync(join(destination, "dist", "index.js"), "utf8"), "export const version = 2")
})

test("materializeLinkedPackages refuses an unrelated installed package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cognia-linked-staging-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, "source")
  const destination = join(root, "node_modules", "@cognia", "redact")
  mkdirSync(source, { recursive: true })
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@cognia/redact" }))
  writeFileSync(join(destination, "package.json"), JSON.stringify({ name: "unrelated" }))
  assert.throws(() => materializeLinkedPackages([{ name: "@cognia/redact", dir: source }], root), /unexpected package/)
  assert.equal(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).name, "unrelated")
})

test("linkedPackageDirs keeps only link: dependencies, resolved against the sidecar", () => {
  const dirs = linkedPackageDirs(
    {
      dependencies: { "@cognia/redact": "link:../packages/redact", zod: "^4.0.0" },
      optionalDependencies: { "@cognia/extra": "link:../packages/extra", "node-pty": "^1.0.0" },
    },
    "/repo/sidecar"
  )
  assert.deepEqual(dirs, [
    { name: "@cognia/redact", dir: resolve("/repo/packages/redact") },
    { name: "@cognia/extra", dir: resolve("/repo/packages/extra") },
  ])
})

test("runtimeCogniaSpecifiers finds runtime imports and skips type-only ones", () => {
  const source = [
    'import { hasNoLeakingPiiDeep } from "@cognia/redact"',
    'import type { SendOptions } from "@cognia/agent-config-types"',
    'export type { ClaudeEvent } from "@cognia/agent-config-types"',
    'export { classify } from "@cognia/agent-config-types/claude-agent-sdk-options"',
    'import "@cognia/side-effect"',
    'const lazy = await import("@cognia/lazy")',
    "// see `@cognia/agent-config-types/agent-execution` for the contract",
    "import {",
    "  a,",
    "  b,",
    '} from "@cognia/multi-line"',
  ].join("\n")
  assert.deepEqual([...runtimeCogniaSpecifiers(source)].sort(), [
    "@cognia/agent-config-types/claude-agent-sdk-options",
    "@cognia/lazy",
    "@cognia/multi-line",
    "@cognia/redact",
    "@cognia/side-effect",
  ])
})

test("unshippableResolutions flags TypeScript targets and resolution failures", () => {
  assert.deepEqual(
    unshippableResolutions({
      "@cognia/ok": "file:///repo/packages/ok/dist/index.js",
      "@cognia/source": "file:///repo/packages/source/src/index.ts",
      "@cognia/gone": "error:ERR_MODULE_NOT_FOUND",
    }),
    [
      ["@cognia/source", "file:///repo/packages/source/src/index.ts"],
      ["@cognia/gone", "error:ERR_MODULE_NOT_FOUND"],
    ]
  )
})

test("every linked package can build, and the sidecar's runtime imports resolve to its compiled output", () => {
  const manifest = JSON.parse(readFileSync(join(sidecarRoot, "package.json"), "utf8"))
  const linked = linkedPackageDirs(manifest)
  assert.ok(linked.length > 0, "the sidecar links at least one workspace package")
  for (const { name, dir } of linked) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    assert.equal(typeof pkg.scripts?.build, "string", `${name} needs a build script for its node-condition output`)
  }

  const specifiers = collectSidecarCogniaSpecifiers()
  assert.ok(specifiers.includes("@cognia/redact"), "the PII gate import is found by the scan")
  const bad = unshippableResolutions(resolveFromSidecar(specifiers))
  assert.deepEqual(
    bad,
    [],
    "run `node scripts/build/build-sidecar-linked-packages.mjs`; if it still fails, the package lacks a `node` export condition for that subpath"
  )
})

test("the sidecar tsconfig maps exactly the linked packages to their source, for bundlers", () => {
  const manifest = JSON.parse(readFileSync(join(sidecarRoot, "package.json"), "utf8"))
  const linked = linkedPackageDirs(manifest)
  const { config, error } = ts.readConfigFile(join(sidecarRoot, "tsconfig.base.json"), ts.sys.readFile)
  assert.equal(error, undefined)
  const paths = config.compilerOptions.paths
  const mapped = new Set(Object.keys(paths).map((key) => key.replace(/\/\*$/, "")))
  assert.deepEqual([...mapped].sort(), linked.map(({ name }) => name).sort())
  for (const { name, dir } of linked) {
    const srcRel = `../packages/${basename(dir)}/src/`
    assert.ok(paths[name]?.[0]?.startsWith(srcRel), `${name} maps into ${srcRel}`)
    assert.ok(paths[`${name}/*`]?.[0] === `${srcRel}*`, `${name}/* maps to ${srcRel}*`)
  }
})
