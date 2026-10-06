import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import ts from "typescript"

test("scaffold acceptance covers generation, install, typecheck, test, build, lint, and package", () => {
  const source = readFileSync(new URL("./test-author-scaffold.mjs", import.meta.url), "utf8")
  for (const expected of [
    '"scripts", "scaffold", "create-plugin.mjs"',
    "COGNIA_PLUGIN_CLI",
    '"install", "--no-frozen-lockfile", "--prefer-offline"',
    '"types/cognia-plugin-sdk.d.ts"',
    '"types/provider-types/index.d.ts"',
    '"types/provider-core/core/client.d.ts"',
    '"tsc", "--noEmit"',
    '"jest", "--runInBand"',
    '"plugin", "lint"',
    '"plugin", "build"',
  ]) {
    assert.match(source, new RegExp(expected))
  }
})

test("standalone scaffold declares its native build policy and Rust embeds it", () => {
  const policy = readFileSync(
    new URL("../../crates/cognia-plugin-template-ts/pnpm-workspace.yaml", import.meta.url),
    "utf8"
  )
  const workspace = parse(policy)
  assert.deepEqual(workspace.packages, ["."])
  for (const dependency of ["esbuild", "unrs-resolver", "@parcel/watcher"])
    assert.equal(workspace.allowBuilds[dependency], true)
  const generator = readFileSync(
    new URL("../../crates/cognia-cli/src/engine/template.rs", import.meta.url),
    "utf8"
  )
  assert.ok(generator.includes('rel_path: PathBuf::from("pnpm-workspace.yaml")'))
  assert.ok(generator.includes("content: ts::PNPM_WORKSPACE.into()"))
})

test("scaffold installs the public dependencies its vendored declarations expose", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../crates/cognia-plugin-template-ts/package.json", import.meta.url),
      "utf8"
    )
  )
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  }
  const bundle = JSON.parse(
    readFileSync(
      new URL("../../crates/cognia-cli/assets/author-types.json", import.meta.url),
      "utf8"
    )
  )
  for (const file of ["types/cognia-plugin-sdk.d.ts", "types/cognia-plugin-ui.d.ts"]) {
    const source = bundle.files[file].replace(/\/\*[\s\S]*?\*\//g, "")
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("node:") ||
        specifier.startsWith("@cognia/")
      )
        continue
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0]
      assert.ok(dependencies[name], `${file} imports undeclared ${name}`)
    }
  }
})

// ACP's generated experimental protocol names changed in later minor releases.
// Vendored declarations must use the same protocol contract as their source.
test("scaffold pins ACP to the canonical host protocol declaration version", () => {
  const readManifest = (relativePath) =>
    JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"))
  const template = readManifest("../../crates/cognia-plugin-template-ts/package.json")
  const contracts = readManifest("../../packages/agent-contracts/package.json")
  const host = readManifest("../../package.json")
  const sdk = readManifest("../../packages/plugin-sdk/package.json")
  const expected = contracts.dependencies["@agentclientprotocol/sdk"]
  assert.match(expected, /^\d+\.\d+\.\d+$/)
  assert.equal(host.dependencies["@agentclientprotocol/sdk"], expected)
  assert.equal(template.dependencies["@agentclientprotocol/sdk"], expected)
  assert.equal(sdk.peerDependencies["@agentclientprotocol/sdk"], expected)
  const lock = parse(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"))
  const resolution = lock.importers["packages/plugin-sdk"].dependencies["@agentclientprotocol/sdk"]
  assert.equal(resolution.specifier, expected)
  assert.ok(resolution.version.startsWith(`${expected}(`))
})
