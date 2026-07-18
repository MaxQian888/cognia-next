#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const packageRoot = join(repoRoot, "packages/plugin-sdk")
const workDir = mkdtempSync(join(tmpdir(), "cognia-plugin-sdk-pack-"))

function run(command, args, cwd = repoRoot) {
  execFileSync(command, args, { cwd, stdio: "inherit" })
}

try {
  run("pnpm", ["pack", "--pack-destination", workDir], packageRoot)
  const tarball = readdirSync(workDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(workDir, entry))[0]
  if (!tarball) throw new Error("pnpm pack did not create a tarball")

  const unpacked = join(workDir, "unpacked")
  mkdirSync(unpacked)
  run("tar", ["-xzf", tarball, "-C", unpacked])
  const packedPackage = join(unpacked, "package")
  const packedFiles = readdirSync(packedPackage)
  for (const expected of ["dist", "contract", "wit", "README.md", "LICENSE", "package.json"]) {
    if (!packedFiles.includes(expected)) throw new Error(`packed SDK is missing ${expected}`)
  }
  if (packedFiles.includes("src")) throw new Error("packed SDK must not contain host-linked source")

  const declarationText = readdirSync(join(packedPackage, "dist"))
    .filter((entry) => entry.endsWith(".d.ts") || entry.endsWith(".d.cts"))
    .map((entry) => readFileSync(join(packedPackage, "dist", entry), "utf8"))
    .join("\n")
  const declarationsWithoutComments = declarationText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  if (/\b(?:from|import)\s*\(?["']@\//.test(declarationsWithoutComments)) {
    throw new Error("packed declarations contain a monorepo @/ import")
  }
  if (/\b(?:from|import)\s*\(?["']@cognia\//.test(declarationsWithoutComments)) {
    throw new Error("packed declarations depend on an unpublished @cognia package")
  }

  const consumer = join(workDir, "consumer")
  const moduleDir = join(consumer, "node_modules/@cognia/plugin-sdk")
  mkdirSync(dirname(moduleDir), { recursive: true })
  cpSync(packedPackage, moduleDir, { recursive: true })
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n')
  writeFileSync(
    join(consumer, "esm.mjs"),
    'import { definePlugin } from "@cognia/plugin-sdk"; if (definePlugin({ manifest: {} }).manifest == null) process.exit(1)\n'
  )
  writeFileSync(
    join(consumer, "cjs.cjs"),
    'const { defineTool } = require("@cognia/plugin-sdk/api/tool"); const probe = { name: "x" }; if (defineTool(probe) !== probe) process.exit(1)\n'
  )
  writeFileSync(
    join(consumer, "index.ts"),
    'import { defineContextPanel, type PluginManifest } from "@cognia/plugin-sdk";\nconst manifest: PluginManifest = { id: "x", name: "X", description: "X", version: "0.1.0", type: "frontend", capabilities: [], main: "index.js" };\ndefineContextPanel({ id: "x", entry: "panel.js", export: "Panel", resourceKinds: ["project-file"], activity: "inspect", labelKey: "x", label: "X" });\nvoid manifest;\n'
  )

  run("node", ["esm.mjs"], consumer)
  run("node", ["cjs.cjs"], consumer)
  run(
    "node",
    [
      "--input-type=module",
      "--eval",
      'try { await import("@cognia/plugin-sdk/api/not-real"); process.exit(1) } catch {}',
    ],
    consumer
  )
  run(
    join(repoRoot, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "index.ts",
    ],
    consumer
  )
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
