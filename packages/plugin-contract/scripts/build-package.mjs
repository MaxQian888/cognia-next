#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { existsSync, globSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "tsup"
import runtimeConfig from "../tsup.config.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const repoRoot = resolve(packageRoot, "../..")
const require = createRequire(import.meta.url)

export async function buildPackage() {
  await build({ ...runtimeConfig, config: false })
  const cache = join(repoRoot, ".cache")
  mkdirSync(cache, { recursive: true })
  const staging = mkdtempSync(join(cache, "plugin-contract-declarations-"))
  try {
    // Native TypeScript checks and emits this graph once. Feeding its .d.ts
    // output to rollup-dts avoids allocating the legacy compiler's enormous
    // program again for every contract subpath.
    const compiler = join(dirname(require.resolve("@typescript/native/package.json")), "bin/tsc")
    execFileSync(
      process.execPath,
      [
        compiler,
        "-p",
        join(packageRoot, "tsconfig.json"),
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--noEmitOnError",
        "--rootDir",
        repoRoot,
        "--outDir",
        staging,
        "--declarationDir",
        staging,
        "--incremental",
        "false",
        "--checkers",
        "1",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, GOMEMLIMIT: "10GiB", GOMAXPROCS: "2" },
      }
    )
    const entries = Object.fromEntries(
      globSync("src/**/*.ts", { cwd: packageRoot, exclude: ["**/*.test.ts"] })
        .sort()
        .map((source) => {
          const name = source
            .replaceAll("\\", "/")
            .replace(/^src\//, "")
            .replace(/\.ts$/, "")
          const declaration = join(staging, "packages/plugin-contract/src", `${name}.d.ts`)
          if (!existsSync(declaration)) throw new Error(`Missing contract declaration: ${name}`)
          return [name, declaration]
        })
    )
    await build({
      ...runtimeConfig,
      config: false,
      entry: entries,
      tsconfig: join(packageRoot, "tsconfig.json"),
      outDir: join(packageRoot, "dist"),
      dts: { only: true, compilerOptions: { baseUrl: staging } },
      clean: false,
    })
    for (const name of Object.keys(entries)) {
      for (const extension of ["d.ts", "d.cts"]) {
        if (!existsSync(join(packageRoot, "dist", `${name}.${extension}`)))
          throw new Error(`Missing bundled contract declaration: ${name}.${extension}`)
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPackage()
}
