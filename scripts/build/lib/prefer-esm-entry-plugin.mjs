import fs from "node:fs"
import path from "node:path"

import { findInstalledPackage } from "./copy-runtime-closure.mjs"

// esbuild on `platform: "node"` prefers a package's `main` over `module`. For a
// package whose `main` is a UMD build (jsonc-parser), the inlined copy keeps
// its AMD-style `require("./impl/format")` calls, which cannot resolve inside a
// single-file bundle: the brain then dies on start (ADR-0224 A1). This plugin
// sends bare imports of the named packages to their `module` (ESM) entry.

/** The ESM entry a package declares, or null. */
export function esmEntryOf(packageDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"))
  return typeof manifest.module === "string" ? path.join(packageDir, manifest.module) : null
}

export function createPreferEsmEntryPlugin({ packages }) {
  const filter = new RegExp(`^(${packages.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`)
  return {
    name: "prefer-esm-entry",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        const packageDir = findInstalledPackage(args.path, args.resolveDir)
        if (!packageDir) return undefined
        const entry = esmEntryOf(packageDir)
        if (!entry) {
          return { errors: [{ text: `${args.path} declares no "module" entry to bundle instead of its main` }] }
        }
        return { path: entry }
      })
    },
  }
}
