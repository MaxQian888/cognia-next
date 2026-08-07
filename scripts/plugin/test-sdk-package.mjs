#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import {
  existsSync,
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

function installedVersion(packageName) {
  for (const root of [repoRoot, packageRoot]) {
    const manifestPath = join(root, "node_modules", packageName, "package.json")
    if (existsSync(manifestPath)) {
      return JSON.parse(readFileSync(manifestPath, "utf8")).version
    }
  }
  throw new Error(`cannot resolve installed version for ${packageName}`)
}

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
  const packedManifest = JSON.parse(readFileSync(join(packedPackage, "package.json"), "utf8"))
  const cogniaDependencies = Object.keys(packedManifest.dependencies || {}).filter((dependency) =>
    dependency.startsWith("@cognia/")
  )
  for (const expected of [
    "@cognia/provider-core",
    "@cognia/provider-routing",
    "@cognia/provider-types",
  ]) {
    if (!cogniaDependencies.includes(expected)) {
      throw new Error(`packed SDK is missing declared Cognia dependency ${expected}`)
    }
  }
  const declarationDependencies = new Set(
    Array.from(declarationsWithoutComments.matchAll(/["'](@cognia\/[^/"']+)/g), (match) => match[1])
  )
  for (const dependency of declarationDependencies) {
    if (!cogniaDependencies.includes(dependency)) {
      throw new Error(`packed declarations use undeclared Cognia dependency ${dependency}`)
    }
  }

  const consumer = join(workDir, "consumer")
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        type: "module",
        private: true,
        packageManager: "pnpm@10.30.3",
        dependencies: {
          "@cognia/provider-core": `link:${join(repoRoot, "packages/provider-core")}`,
          "@cognia/provider-routing": `link:${join(repoRoot, "packages/provider-routing")}`,
          "@cognia/provider-types": `link:${join(repoRoot, "packages/provider-types")}`,
        },
        pnpm: {
          overrides: {
            "@cognia/provider-core": `link:${join(repoRoot, "packages/provider-core")}`,
            "@cognia/provider-routing": `link:${join(repoRoot, "packages/provider-routing")}`,
            "@cognia/provider-types": `link:${join(repoRoot, "packages/provider-types")}`,
          },
        },
      },
      null,
      2
    )}\n`
  )
  run(
    "pnpm",
    [
      "add",
      tarball,
      `react@${installedVersion("react")}`,
      `ai@${installedVersion("ai")}`,
      `dexie@${installedVersion("dexie")}`,
      `@types/react@${installedVersion("@types/react")}`,
      `@types/node@${installedVersion("@types/node")}`,
      `@types/json-schema@${installedVersion("@types/json-schema")}`,
    ],
    consumer
  )
  writeFileSync(
    join(consumer, "esm.mjs"),
    [
      'import { definePlugin } from "@cognia/plugin-sdk";',
      'import { SystemEvents } from "@cognia/plugin-sdk/events";',
      'import { CANONICAL_EXTENSION_POINTS } from "@cognia/plugin-sdk/extensions";',
      'import { defineContextPanel } from "@cognia/plugin-sdk/api/context-panel";',
      "if (definePlugin({ manifest: {} }).manifest == null) process.exit(1);",
      'if (SystemEvents.PLUGIN_LOADED !== "system:plugin:loaded") process.exit(1);',
      'if (!CANONICAL_EXTENSION_POINTS.includes("chat.input.above")) process.exit(1);',
      'if (defineContextPanel({ id: "panel", entry: "panel.js", export: "Panel", resourceKinds: ["project-file"], activity: "inspect", labelKey: "panel", label: "Panel" }).id !== "panel") process.exit(1);',
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
      'import { PLUGIN_CONTRACT_VERSION, PLUGIN_GATEWAY_CLIENT_VERSION, type PluginApiNamespaceContract } from "@cognia/plugin-sdk/contracts";',
      'import type { EventFilter } from "@cognia/plugin-sdk/events";',
      'import type { PluginHooks } from "@cognia/plugin-sdk/hooks";',
      'import type { PluginPermission } from "@cognia/plugin-sdk/permissions";',
      'import type { ExtensionPoint } from "@cognia/plugin-sdk/extensions";',
      "// @ts-expect-error definePlugin is not part of the hooks subpath",
      'import { definePlugin as invalidHookExport } from "@cognia/plugin-sdk/hooks";',
      'const manifest: PluginManifest = { id: "x", name: "X", description: "X", version: "0.1.0", type: "frontend", capabilities: [], main: "index.js" };',
      "const probe: [EventFilter?, PluginHooks?, PluginPermission?, ExtensionPoint?] = [];",
      'const contractProbe: ["1.0.0", "2.0.0", PluginApiNamespaceContract?] = [PLUGIN_CONTRACT_VERSION, PLUGIN_GATEWAY_CLIENT_VERSION];',
      'defineContextPanel({ id: "x", entry: "panel.js", export: "Panel", resourceKinds: ["project-file"], activity: "inspect", labelKey: "x", label: "X" });',
      "void manifest; void probe; void contractProbe; void invalidHookExport;",
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
