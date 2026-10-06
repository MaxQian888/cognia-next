#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import ts from "typescript"
import {
  assertAuthorBuildRoot,
  assertStandaloneDeclaration,
} from "../../../scripts/plugin/generate-author-types.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")

function runTsup(cwd, args = []) {
  const require = createRequire(import.meta.url)
  const tsupPackagePath = require.resolve("tsup/package.json")
  const tsupPackage = JSON.parse(readFileSync(tsupPackagePath, "utf8"))
  execFileSync(
    process.execPath,
    [resolve(dirname(tsupPackagePath), tsupPackage.bin.tsup), ...args],
    {
      cwd,
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" },
    }
  )
}

/** A published export must resolve in the archive without the source checkout. */
export function assertDeclaredArtifacts(root = packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  const missing = []
  for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
    for (const target of typeof conditions === "string"
      ? [conditions]
      : Object.values(conditions)) {
      if (typeof target === "string" && !existsSync(resolve(root, target)))
        missing.push(`${subpath} -> ${target}`)
    }
  }
  if (missing.length)
    throw new Error(`Missing plugin SDK artifacts:\n${[...new Set(missing)].join("\n")}`)
  for (const file of readdirSync(resolve(root, "dist"))) {
    if (!/\.d\.(?:c|m)?ts$/.test(file)) continue
    const declaration = readFileSync(resolve(root, "dist", file), "utf8")
    assertStandaloneDeclaration(declaration)
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const { fileName: specifier } of ts.preProcessFile(declaration).importedFiles) {
      if (!specifier.startsWith(".")) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]
        if (!specifier.startsWith("node:") && !dependencies[packageName]) {
          throw new Error(`Undeclared SDK declaration dependency: ${file} -> ${specifier}`)
        }
        continue
      }
      const target = resolve(root, "dist", specifier)
      const candidates = [
        target,
        target
          .replace(/\.mjs$/, ".d.mts")
          .replace(/\.cjs$/, ".d.cts")
          .replace(/\.js$/, ".d.ts"),
        `${target}.d.ts`,
        resolve(target, "index.d.ts"),
      ]
      if (
        !candidates.some((candidate) => /\.d\.(?:c|m)?ts$/.test(candidate) && existsSync(candidate))
      )
        throw new Error(`Missing SDK declaration dependency: ${file} -> ${specifier}`)
    }
  }
}

export function buildPackage() {
  runTsup(packageRoot)
  // tsup DTS treats cwd production dependencies as external even when noExternal
  // is set. Match the existing author declaration build's verified root cwd.
  assertAuthorBuildRoot(JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")))
  runTsup(repoRoot, ["--config", resolve(packageRoot, "tsup.package-types.config.ts")])
  assertDeclaredArtifacts()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPackage()
}
