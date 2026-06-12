#!/usr/bin/env node
/**
 * `pnpm plugin:codegen <plugin-dir>` — regenerate the typed config accessors
 * for an existing plugin from its `plugin.json#configSchema`.
 *
 * Thin fs/argv wrapper over `generateConfigArtifacts`. The core is the
 * injectable `runCodegen({ pluginDir, readFile, writeFile })` so it unit-tests
 * with an in-memory filesystem.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { generateConfigArtifacts } from "./config-codegen.mjs"

/**
 * Read a plugin's manifest, generate its config artifacts, and write them back
 * into the plugin dir. Returns the list of written paths.
 */
export function runCodegen({ pluginDir, readFile, writeFile, log = () => {} }) {
  const manifestPath = join(pluginDir, "plugin.json")
  let manifest
  try {
    manifest = JSON.parse(readFile(manifestPath))
  } catch (error) {
    throw new Error(`failed to read plugin manifest at ${manifestPath}: ${error.message}`)
  }
  const artifacts = generateConfigArtifacts(manifest)
  const written = []
  for (const [rel, content] of Object.entries(artifacts)) {
    const dest = join(pluginDir, rel)
    writeFile(dest, content)
    written.push(dest)
    log(`wrote ${dest}`)
  }
  return written
}

function main(argv) {
  const dir = argv[0]
  if (!dir) {
    console.error("usage: node scripts/scaffold/plugin-codegen.mjs <plugin-dir>")
    process.exitCode = 1
    return
  }
  const written = runCodegen({
    pluginDir: resolve(dir),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content),
    log: (message) => console.log(message),
  })
  if (written.length === 0) {
    console.log("no config artifacts generated (manifest has no configSchema for this type)")
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
