#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { mergeTimingManifests, writeTimingManifest } = require("./jest-timing-sequencer.cjs")

export function parseArgs(argv) {
  const outIndex = argv.indexOf("--out")
  if (outIndex === -1 || !argv[outIndex + 1]) {
    throw new Error("--out requires a timing manifest path")
  }
  const output = argv[outIndex + 1]
  const inputs = argv.filter((_, index) => index !== outIndex && index !== outIndex + 1)
  if (inputs.length === 0) throw new Error("No timing manifests given")
  return { inputs, output }
}

export function mergeTimingFiles(inputs, output) {
  const missing = inputs.filter((input) => !existsSync(input))
  if (missing.length > 0) throw new Error(`Timing manifest(s) not found: ${missing.join(", ")}`)
  const manifests = inputs.map((input) => JSON.parse(readFileSync(input, "utf8")))
  const merged = mergeTimingManifests(manifests)
  writeTimingManifest(output, merged)
  return Object.keys(merged.tests).length
}

function main() {
  const { inputs, output } = parseArgs(process.argv.slice(2))
  const count = mergeTimingFiles(inputs, output)
  console.log(`[jest-timings] merged ${inputs.length} manifest(s) with ${count} suite timings`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[jest-timings] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
