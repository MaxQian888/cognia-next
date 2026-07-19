#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, "package.json"),
    '{"type":"module","private":true,"packageManager":"pnpm@10.30.3"}\n'
  )
  run(
    "pnpm",
    [
      "add",
      tarball,
      "react@^19.0.0",
      "ai@^6.0.0",
      "dexie@^4.0.0",
      "@types/react@^19.0.0",
      "@types/node@^22.0.0",
      "@types/json-schema@^7.0.0",
    ],
    consumer
  )
  writeFileSync(
    join(consumer, "esm.mjs"),
    [
      'import { definePlugin } from "@cognia/plugin-sdk";',
      'import { SystemEvents } from "@cognia/plugin-sdk/events";',
      'import { CANONICAL_EXTENSION_POINTS } from "@cognia/plugin-sdk/extensions";',
      "if (definePlugin({ manifest: {} }).manifest == null) process.exit(1);",
      'if (SystemEvents.PLUGIN_LOADED !== "system:plugin:loaded") process.exit(1);',
      'if (!CANONICAL_EXTENSION_POINTS.includes("chat.input.above")) process.exit(1);',
      "",
    ].join("\n")
  )
  writeFileSync(
    join(consumer, "cjs.cjs"),
    'const { defineTool } = require("@cognia/plugin-sdk/api/tool"); const probe = { name: "x" }; if (defineTool(probe) !== probe) process.exit(1)\n'
  )
  writeFileSync(
    join(consumer, "index.ts"),
    [
      'import { defineContextPanel, type PluginManifest } from "@cognia/plugin-sdk";',
      'import type { EventFilter } from "@cognia/plugin-sdk/events";',
      'import type { PluginHooks } from "@cognia/plugin-sdk/hooks";',
      'import type { PluginPermission } from "@cognia/plugin-sdk/permissions";',
      'import type { ExtensionPoint } from "@cognia/plugin-sdk/extensions";',
      "// @ts-expect-error definePlugin is not part of the hooks subpath",
      'import { definePlugin as invalidHookExport } from "@cognia/plugin-sdk/hooks";',
      'const manifest: PluginManifest = { id: "x", name: "X", description: "X", version: "0.1.0", type: "frontend", capabilities: [], main: "index.js" };',
      "const probe: [EventFilter?, PluginHooks?, PluginPermission?, ExtensionPoint?] = [];",
      'defineContextPanel({ id: "x", entry: "panel.js", export: "Panel", resourceKinds: ["project-file"], activity: "inspect", labelKey: "x", label: "X" });',
      "void manifest; void probe; void invalidHookExport;",
      "",
    ].join("\n")
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
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--types",
      "node,react",
      "index.ts",
    ],
    consumer
  )
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
