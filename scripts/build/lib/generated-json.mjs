/**
 * Shared plumbing for generators that write a checked-in JSON file from
 * TypeScript sources (ADR-0217 catalog generation).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { format, resolveConfig } from "prettier"

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/**
 * Bundle a TypeScript module source (resolved against the repo's tsconfig
 * `paths`, so `@/…` and `@cognia/…` work) and import the result.
 */
export async function loadTsExports(contents) {
  const result = await build({
    stdin: { contents, resolveDir: REPO_ROOT, loader: "ts" },
    absWorkingDir: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "tsconfig.json"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
}

/**
 * `value` as the file would be written: expanded objects (as these files have
 * always been written), then the repo's prettier settings, which pack short
 * arrays.
 */
export async function renderJson(path, value) {
  const options = (await resolveConfig(path)) ?? {}
  return format(JSON.stringify(value, null, 2), { ...options, filepath: path })
}

/**
 * Write `next` to `path`, or with `check` report drift instead. Returns the
 * process exit code.
 */
export function writeOrCheck(path, current, next, { check, label, hint }) {
  const rel = relative(REPO_ROOT, path)
  if (current === next) {
    console.log(`[${label}] ${rel} is up to date`)
    return 0
  }
  if (check) {
    console.error(`[${label}] ${rel} differs from its sources. ${hint}`)
    return 1
  }
  writeFileSync(path, next)
  console.log(`[${label}] wrote ${rel}`)
  return 0
}

export function readText(path) {
  return readFileSync(path, "utf8")
}
