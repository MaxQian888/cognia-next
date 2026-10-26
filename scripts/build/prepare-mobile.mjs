#!/usr/bin/env node

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// Reuse the frontend resource producers from prebuild. Native sidecars, browser
// binaries and desktop plugin staging are not consumed by Capacitor, so the
// plugin artifact set is staged without its desktop section. Frontend
// workspace packages resolve to source through tsconfig paths.
export async function prepareMobile(
  run = (command, args) => execa(command, args, { cwd: root, stdio: "inherit" })
) {
  for (const [script, ...args] of [
    ["build-workflow-app-embed.mjs"],
    ["stage-plugin-artifacts.mjs", "--web-only"],
    ["download-cubism-core.mjs"],
    ["copy-monaco-assets.mjs"],
    ["build-artifact-runtime.mjs"],
    ["copy-ocr-assets.mjs"],
    ["build-builtin-skills.mjs"],
    ["build-support-docs.mjs"],
  ]) {
    await run(process.execPath, [`scripts/build/${script}`, ...args])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMobile().catch((error) => {
    console.error(`[mobile:prepare] ${error.message}`)
    process.exitCode = 1
  })
}
