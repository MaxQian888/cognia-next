#!/usr/bin/env node

/**
 * End-to-end proof that `cognia plugin new` produces a project a third-party
 * author can actually use.
 *
 * This test used to pack the SDK locally, rewrite the scaffold's `package.json`
 * to point at the tarball, and inject `@cognia/provider-*` link: overrides plus
 * `ai` / `dexie` / `react` / `@types/*`. That made it pass while the real author
 * path was broken: none of the `@cognia/*` packages are published (the SDK is a
 * 404 on npm), so an author running plain `pnpm install` got nothing but a
 * resolution failure.
 *
 * The scaffold now vendors the declarations it needs (see
 * `scripts/plugin/generate-author-types.mjs`) and declares only real, published
 * dependencies. So this harness injects nothing — whatever the scaffold emits is
 * what an author gets, and every step below runs against exactly that.
 */

import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const workDir = mkdtempSync(join(tmpdir(), "cognia-author-scaffold-"))
const pluginDir = join(workDir, "sdk-probe")

function run(command, args, cwd = repoRoot, env = {}) {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } })
}

try {
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

  // Nothing below may depend on this repo's node_modules or workspace links.
  const packageJson = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"))
  const declared = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  }
  for (const [name, spec] of Object.entries(declared)) {
    assert.ok(
      !name.startsWith("@cognia/"),
      `scaffold must not depend on the unpublished ${name} — vendor its declarations instead`
    )
    assert.ok(
      !/^(file:|link:|workspace:)/.test(spec),
      `scaffold dependency ${name} must resolve from the registry, got "${spec}"`
    )
  }

  // The declarations the scaffold vendors in place of those packages.
  for (const declaration of [
    "types/cognia-plugin-sdk.d.ts",
    "types/cognia-plugin-ui.d.ts",
    "types/provider-types/index.d.ts",
    "types/provider-core/core/client.d.ts",
  ]) {
    assert.ok(existsSync(join(pluginDir, declaration)), `scaffold must vendor ${declaration}`)
  }

  run("pnpm", ["install", "--prefer-offline"], pluginDir)
  run("pnpm", ["exec", "tsc", "--noEmit"], pluginDir)
  run("pnpm", ["exec", "jest", "--runInBand"], pluginDir)
  run("pnpm", ["build"], pluginDir)
  run(cli, ["plugin", "lint", "--path", pluginDir])
  run(cli, ["plugin", "build", "--path", pluginDir])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
