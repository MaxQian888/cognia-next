import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { assertDeclaredArtifacts } from "./build-package.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("resolves transitive host adapter and UI imports to workspace source", () => {
  const config = ts.readConfigFile(resolve(packageRoot, "tsconfig.json"), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
  const containingFile = resolve(packageRoot, "src/index.ts")

  for (const subpath of [
    "agent-a2a/client",
    "agent-acp/feature-profile",
    "agent-aider/manifest",
    "agent-claude-code/manifest",
    "agent-codex/app-server-client",
    "agent-dsh/managed-launch",
    "agent-opencode/discovery",
    "agent-pi/auth",
    "plugin-ui/motion-tokens",
  ]) {
    const resolved = ts.resolveModuleName(
      `@cognia/${subpath}`,
      containingFile,
      parsed.options,
      ts.sys
    ).resolvedModule
    const [name, ...entry] = subpath.split("/")
    assert.equal(
      resolved?.resolvedFileName,
      resolve(packageRoot, "..", name, "src", `${entry.join("/")}.ts`),
      `${subpath} must resolve without prebuilt declarations`
    )
  }
})

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "sdk-artifact-check-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(resolve(root, "dist"))
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({
      exports: {
        "./api/pet": {
          types: "./dist/pet.d.ts",
          import: "./dist/pet.js",
          require: "./dist/pet.cjs",
        },
      },
    })
  )
  writeFileSync(resolve(root, "dist/pet.js"), "export const api = true")
  writeFileSync(resolve(root, "dist/pet.cjs"), "exports.api = true")
  return root
}

test("fails packaging when an exported declaration is absent", (t) => {
  const root = fixture(t)
  assert.throws(() => assertDeclaredArtifacts(root), /api\/pet.*pet\.d\.ts/)
  writeFileSync(resolve(root, "dist/pet.d.ts"), "export declare const api: boolean")
  assert.doesNotThrow(() => assertDeclaredArtifacts(root))
})

test("rejects declarations that would require the host checkout", (t) => {
  const root = fixture(t)
  writeFileSync(resolve(root, "dist/pet.d.ts"), 'export { Pet } from "@/types/pet"')
  assert.throws(() => assertDeclaredArtifacts(root), /host paths/)
})

test("the package test rebuilds declarations before packing", () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
  assert.match(manifest.scripts["pack:test"], /pnpm build/)
})

test("checks shared declaration chunks and their relative dependencies", (t) => {
  const root = fixture(t)
  writeFileSync(resolve(root, "dist/pet.d.ts"), 'export { api } from "./shared.js"')
  assert.throws(() => assertDeclaredArtifacts(root), /Missing SDK declaration dependency/)
  writeFileSync(resolve(root, "dist/shared.d.ts"), "export declare const api: boolean")
  assert.doesNotThrow(() => assertDeclaredArtifacts(root))
  writeFileSync(resolve(root, "dist/shared.d.mts"), 'export { Pet } from "@/types/pet"')
  assert.throws(() => assertDeclaredArtifacts(root), /host paths/)
})

test("requires direct dependency metadata for public declaration imports", (t) => {
  const root = fixture(t)
  writeFileSync(resolve(root, "dist/pet.d.ts"), 'export type { ZodType } from "zod"')
  assert.throws(() => assertDeclaredArtifacts(root), /Undeclared SDK declaration dependency.*zod/)
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  manifest.peerDependencies = { zod: "^4.0.0" }
  writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest))
  assert.doesNotThrow(() => assertDeclaredArtifacts(root))
})

test("declares the schema dependency exposed by portable handoff policy types", () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
  const agentManifest = JSON.parse(
    readFileSync(resolve(packageRoot, "../agent/package.json"), "utf8")
  )
  assert.equal(manifest.dependencies.valibot, agentManifest.dependencies.valibot)
})
