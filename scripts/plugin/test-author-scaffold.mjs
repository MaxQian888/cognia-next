#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
  run("pnpm", ["plugin:create", "--", "sdk-probe", "--dir", pluginDir, "--kind", "ts"], repoRoot, {
    COGNIA_PLUGIN_CLI: cli,
  })

  const packagePath = join(pluginDir, "package.json")
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))
  packageJson.dependencies["@cognia/plugin-sdk"] = `file:${sdkTarball}`
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  run("pnpm", ["install", "--no-frozen-lockfile"], pluginDir)
  run("pnpm", ["exec", "tsc", "--noEmit"], pluginDir)
  run("pnpm", ["exec", "jest", "--runInBand"], pluginDir)
  run("pnpm", ["build"], pluginDir)
  run(cli, ["plugin", "lint", "--path", pluginDir])
  run(cli, ["plugin", "build", "--path", pluginDir])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
