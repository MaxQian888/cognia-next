#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const sdkRoot = join(repoRoot, "packages/plugin-sdk")
const workDir = mkdtempSync(join(tmpdir(), "cognia-author-scaffold-"))
const pluginDir = join(workDir, "sdk-probe")

function run(command, args, cwd = repoRoot, env = {}) {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } })
}

function installedVersion(packageName) {
  for (const root of [repoRoot, sdkRoot]) {
    const manifestPath = join(root, "node_modules", packageName, "package.json")
    if (existsSync(manifestPath)) {
      return JSON.parse(readFileSync(manifestPath, "utf8")).version
    }
  }
  throw new Error(`cannot resolve installed version for ${packageName}`)
}

try {
  run("pnpm", ["pack", "--pack-destination", workDir], sdkRoot)
  const sdkTarball = readdirSync(workDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(workDir, entry))[0]
  if (!sdkTarball) throw new Error("plugin SDK pack did not produce a tarball")

  run("cargo", ["build", "--quiet", "-p", "cognia-cli"])
  const cli = join(
    repoRoot,
    "target",
    "debug",
    process.platform === "win32" ? "cognia.exe" : "cognia"
  )
  run(
    "pnpm",
    [
      "plugin:create",
      "--",
      "sdk-probe",
      "--dir",
      pluginDir,
      "--kind",
      "ts",
      "--yes",
      "--description",
      "Standalone author SDK scaffold probe",
      "--author",
      "Cognia SDK Test",
    ],
    repoRoot,
    { COGNIA_PLUGIN_CLI: cli }
  )

  const packagePath = join(pluginDir, "package.json")
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))
  assert.equal(
    packageJson.dependencies["@cognia/plugin-sdk"],
    "^0.1.0",
    "canonical scaffold must target the currently published SDK contract"
  )
  packageJson.dependencies["@cognia/plugin-sdk"] = `file:${sdkTarball}`
  packageJson.dependencies["@cognia/provider-core"] =
    `link:${join(repoRoot, "packages/provider-core")}`
  packageJson.dependencies["@cognia/provider-routing"] =
    `link:${join(repoRoot, "packages/provider-routing")}`
  packageJson.dependencies["@cognia/provider-types"] =
    `link:${join(repoRoot, "packages/provider-types")}`
  packageJson.dependencies.ai = installedVersion("ai")
  packageJson.dependencies.dexie = installedVersion("dexie")
  packageJson.dependencies.react = installedVersion("react")
  packageJson.devDependencies["@types/json-schema"] = installedVersion("@types/json-schema")
  packageJson.devDependencies["@types/node"] = installedVersion("@types/node")
  packageJson.devDependencies["@types/react"] = installedVersion("@types/react")
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@cognia/provider-core": `link:${join(repoRoot, "packages/provider-core")}`,
      "@cognia/provider-routing": `link:${join(repoRoot, "packages/provider-routing")}`,
      "@cognia/provider-types": `link:${join(repoRoot, "packages/provider-types")}`,
    },
  }
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  run("pnpm", ["install", "--no-frozen-lockfile", "--prefer-offline"], pluginDir)
  run("pnpm", ["exec", "tsc", "--noEmit"], pluginDir)
  run("pnpm", ["exec", "jest", "--runInBand"], pluginDir)
  run("pnpm", ["build"], pluginDir)
  run(cli, ["plugin", "lint", "--path", pluginDir])
  run(cli, ["plugin", "build", "--path", pluginDir])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
