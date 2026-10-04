#!/usr/bin/env node

import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  isBuildCacheFresh,
  readBuildCache,
  saveBuildCache,
  writeIfChanged,
} from "./esbuild-input-cache.mjs"

const generatorFile = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(generatorFile), "../..")

export async function buildWorkflowAppEmbed({ root = repoRoot, bundle } = {}) {
  root = path.resolve(root)
  const outfile = path.join(root, "public/cognia-workflow-app.js")
  const cacheFile = path.join(root, ".cache/build/workflow-app-embed.json")
  const cache = readBuildCache(cacheFile)
  const key = "workflow-app-embed-v1"
  if (isBuildCacheFresh(cache, root, key, [outfile])) return { cached: true, changed: false }

  const startedAt = performance.timeOrigin + performance.now()
  const build = bundle ?? (await import("esbuild")).build
  const result = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "scripts/build/cognia-workflow-app.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile,
    banner: { js: "// Generated from scripts/build/cognia-workflow-app.ts; do not edit directly." },
    metafile: true,
    write: false,
  })
  const outputs = result.outputFiles.map((file) => file.path)
  if (!outputs.includes(outfile))
    throw new Error("Workflow embed build did not produce its JavaScript entry")
  let changed = false
  for (const output of result.outputFiles)
    changed = writeIfChanged(output.path, output.contents) || changed
  // Only the known companion outputs belong to this generator; never prune
  // unrelated public assets based on an editable cache record.
  for (const oldOutput of Object.keys(cache?.outputs ?? {})) {
    if (
      path.dirname(oldOutput) === path.dirname(outfile) &&
      /^cognia-workflow-app\.(?:js|css)(?:\.map)?$/.test(path.basename(oldOutput)) &&
      !outputs.includes(oldOutput)
    ) {
      await rm(oldOutput, { force: true })
    }
  }
  saveBuildCache(cacheFile, {
    root,
    key,
    inputs: Object.keys(result.metafile.inputs),
    outputs,
    extraFiles: [generatorFile],
    startedAt,
  })
  return { cached: false, changed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === generatorFile) {
  const result = await buildWorkflowAppEmbed()
  console.log(
    `[workflow-app:embed] ${result.cached ? "cached" : result.changed ? "built" : "unchanged"}`
  )
}
