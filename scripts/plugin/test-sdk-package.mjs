#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import {
  cpSync,
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
        // Only this project's own direct edges. The edge that actually matters
        // — `@cognia/plugin-sdk` -> these three — is rewritten by the
        // `overrides` in the pnpm-workspace.yaml written below.
        dependencies: {
          "@cognia/provider-core": `link:${join(repoRoot, "packages/provider-core")}`,
          "@cognia/provider-routing": `link:${join(repoRoot, "packages/provider-routing")}`,
          "@cognia/provider-types": `link:${join(repoRoot, "packages/provider-types")}`,
        },
      },
      null,
      2
    )}\n`
  )
  // The packed SDK declares all three providers as `"0.0.0"` — a version no
  // registry serves, since none of them are published. Without an override the
  // install dies on "@cognia/provider-routing is not in the npm registry":
  // provider-routing has no direct edge at all, it is reachable only through
  // the SDK. This used to live in the manifest's `pnpm.overrides`, which pnpm
  // 10.30 still honours but warns about on every run, and pnpm 11 ignores
  // outright — at which point the harness would have broken exactly that way.
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    [
      "packages: []",
      "overrides:",
      ...["provider-core", "provider-routing", "provider-types"].map(
        (name) => `  "@cognia/${name}": "link:${join(repoRoot, "packages", name)}"`
      ),
      "",
    ].join("\n")
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
      // The packed declarations import ACP types at the top level, so an author
      // cannot type-check ANY SDK import without this peer resolving.
      `@agentclientprotocol/sdk@${installedVersion("@agentclientprotocol/sdk")}`,
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
      'const contractProbe: ["1.1.0", "2.0.0", PluginApiNamespaceContract?] = [PLUGIN_CONTRACT_VERSION, PLUGIN_GATEWAY_CLIENT_VERSION];',
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

  // ── Reference-plugin isolation ───────────────────────────────────────────
  // Type-check a REAL in-tree plugin against the packed SDK alone, in a
  // directory that inherits none of the repo's `@/*` path aliases.
  //
  // The import gate (`check-author-imports.mjs`) can only see the specifiers a
  // file writes. This proves the stronger property: that the SDK's published
  // types actually CARRY everything Deep Research needs. A type the SDK forgot
  // to export still resolves inside the monorepo — tsconfig maps it straight to
  // the host source — and would only fail for the first outside author to try.
  const providerTypePaths = {}
  for (const [name, dist] of [
    ["@cognia/provider-types", join(repoRoot, "packages/provider-types/dist")],
    ["@cognia/provider-core", join(repoRoot, "packages/provider-core/dist")],
  ]) {
    if (!existsSync(join(dist, "index.d.ts"))) {
      throw new Error(`${name} has no built declarations at ${dist} — run its build first`)
    }
    providerTypePaths[name] = [join(dist, "index.d.ts")]
    providerTypePaths[`${name}/*`] = [join(dist, "*.d.ts")]
  }

  const pluginSource = join(repoRoot, "plugins/deep-research")
  const pluginDir = join(consumer, "deep-research")
  cpSync(pluginSource, pluginDir, {
    recursive: true,
    filter: (entry) => !/\.(test|spec)\.tsx?$/.test(entry),
  })
  writeFileSync(
    join(consumer, "tsconfig.plugin.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          noEmit: true,
          strict: true,
          exactOptionalPropertyTypes: true,
          target: "ES2022",
          module: "ESNext",
          // Bundler resolution, matching how the host compiles plugin sources:
          // extensionless relative imports, package `exports` respected.
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          esModuleInterop: true,
          skipLibCheck: true,
          lib: ["ES2022", "DOM"],
          types: ["node"],
          // No `@/*` host aliases — an author's project has none, so neither
          // does this. The two entries below are NOT host aliases. The packed
          // declarations deliberately keep `@cognia/provider-types` (five
          // subpaths) and `@cognia/provider-core/core/client` as bare imports,
          // and `generate-author-types.mjs` vendors those two packages' BUILT
          // `.d.ts` trees into the CLI's author-types asset — so a scaffolded
          // project resolves them to declarations, which `skipLibCheck` then
          // skips. Without these, the workspace `link:` routes them to
          // `src/*.ts` instead (their `exports` map has no dist entry at all,
          // every condition points at source) and tsc type-checks HOST code
          // under the plugin's stricter flags. That is not what an author
          // gets, and not what this test is for.
          paths: providerTypePaths,
        },
        include: ["deep-research/**/*.ts"],
      },
      null,
      2
    )}\n`
  )
  run(join(repoRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.plugin.json"], consumer)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
