// Build the standalone Cognia CLI release executable with Bun 1.4.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createCliExternalAgentAliasPlugin } from "./cli-external-agent-aliases.mjs"
import {
  cliTarget,
  hostTargetName,
  parseCliBuildArgs,
} from "./cli-bun-contract.mjs"
import { signCliArtifacts } from "./sign-cli-bun.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const entry = path.join(root, "cli/src/cli/entry.ts")
const hostTarget = hostTargetName(process.platform, process.arch)
const buildArgs = parseCliBuildArgs(process.argv.slice(2), hostTarget)

if (buildArgs.layoutOnly) {
  const legacyLayout = Bun.spawn(
    ["node", path.join(root, "scripts/build/build-cli-binary.mjs"), "--layout-only"],
    { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  )
  process.exit(await legacyLayout.exited)
}

const target = cliTarget(buildArgs.targetName)
const binDir = path.join(root, "cli/dist/bin")
const outdir = path.join(binDir, target.dist)
const outfile = path.join(outdir, target.executable)

const [bunMajor, bunMinor] = Bun.version.split(".").map(Number)
if (bunMajor < 1 || (bunMajor === 1 && bunMinor < 4)) {
  throw new Error(`build-cli-bun: Bun 1.4+ is required; found ${Bun.version}`)
}

function replaceExactly(source, search, replacement, label) {
  const matches =
    typeof search === "string"
      ? source.split(search).length - 1
      : [...source.matchAll(new RegExp(search.source, search.flags.includes("g") ? search.flags : `${search.flags}g`))]
          .length
  if (matches !== 1) {
    throw new Error(`build-cli-bun: ${label} expected exactly one source match; found ${matches}`)
  }
  return source.replace(search, () => replacement)
}

function findPnpmPackageDir(packageName) {
  const store = path.join(root, "sidecar/node_modules/.pnpm")
  const encoded = packageName.replace("/", "+")
  const entryName = fs
    .readdirSync(store)
    .filter((name) => name.startsWith(`${encoded}@`))
    .sort()
    .at(-1)
  if (!entryName) {
    throw new Error(
      `build-cli-bun: ${packageName} is not installed for ${target.name}; run pnpm install on the target runner`
    )
  }
  const [scope, name] = packageName.split("/")
  return path.join(store, entryName, "node_modules", scope, name)
}

const claudeBinary = path.join(
  findPnpmPackageDir(target.claudePackage),
  target.claudeBinary
)
if (!fs.statSync(claudeBinary, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`build-cli-bun: missing Claude executable ${claudeBinary}`)
}

const executableSuffix = target.name === "win32-x64" ? ".exe" : ""
const externalHostLauncherName = `cognia-external-agent-launcher${executableSuffix}`
const workspaceHelperName = `cognia-task-workspace-worker${executableSuffix}`
const externalHostLauncher =
  process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER_PATH ||
  path.join(root, "target", "release", externalHostLauncherName)
const workspaceHelper =
  process.env.COGNIA_TASK_WORKSPACE_WORKER_PATH ||
  path.join(root, "target", "release", workspaceHelperName)

if (target.name !== hostTarget && !process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER_PATH) {
  throw new Error(
    `build-cli-bun: cross-target ${target.name} requires target-native helper paths; build on a native runner or set COGNIA_EXTERNAL_AGENT_LAUNCHER_PATH and COGNIA_TASK_WORKSPACE_WORKER_PATH`
  )
}
for (const helper of [externalHostLauncher, workspaceHelper]) {
  if (!fs.statSync(helper, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`build-cli-bun: missing native helper ${path.relative(root, helper)}`)
  }
}

function resolveSourcePath(candidate) {
  const attempts = path.extname(candidate)
    ? [candidate]
    : [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.js`,
        `${candidate}.mjs`,
        path.join(candidate, "index.ts"),
        path.join(candidate, "index.tsx"),
        path.join(candidate, "index.js"),
      ]
  return attempts.find((attempt) => {
    try {
      return fs.statSync(attempt).isFile()
    } catch {
      return false
    }
  })
}

function createTsconfigPathsPlugin() {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"))
  const aliases = Object.entries(tsconfig.compilerOptions?.paths ?? {}).map(([pattern, targets]) => {
    const wildcardIndex = pattern.indexOf("*")
    return {
      pattern,
      prefix: wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex),
      suffix: wildcardIndex === -1 ? "" : pattern.slice(wildcardIndex + 1),
      targets,
      wildcard: wildcardIndex !== -1,
    }
  })

  return {
    name: "root-tsconfig-paths",
    setup(build) {
      build.onResolve({ filter: /^@(?:\/|cognia\/)/ }, (args) => {
        for (const alias of aliases) {
          const matches = alias.wildcard
            ? args.path.startsWith(alias.prefix) && args.path.endsWith(alias.suffix)
            : args.path === alias.pattern
          if (!matches) continue

          const wildcardValue = alias.wildcard
            ? args.path.slice(alias.prefix.length, args.path.length - alias.suffix.length || undefined)
            : ""
          for (const target of alias.targets) {
            const candidate = path.resolve(root, target.replace("*", wildcardValue))
            const resolved = resolveSourcePath(candidate)
            if (resolved) return { path: resolved }
          }
        }
        return undefined
      })
    },
  }
}

const stubRuntimePlugin = {
  name: "stub-browser-runtime",
  setup(build) {
    build.onResolve(
      { filter: /^(?:next\/|server-only$|client-only$|react-devtools-core$)/ },
      (args) => ({ path: args.path, namespace: "cli-stub" })
    )
    build.onLoad({ filter: /.*/, namespace: "cli-stub" }, () => ({
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

const assetPlugin = {
  name: "stub-static-assets",
  setup(build) {
    build.onLoad({ filter: /\.(?:css|svg|ttf|woff2?)$/ }, () => ({
      contents: "export default '';",
      loader: "js",
    }))
  },
}

const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n[\\/]messages[\\/][^\\/]+\.json$/ }, async (args) => ({
      contents: `export default ${await Bun.file(args.path).text()}`,
      loader: "js",
    }))
  },
}

// The Node/pkg layout loads these roles from adjacent files. A compiled Bun
// executable cannot resolve pnpm workspace links while dynamically importing
// those external files, so embed the three multi-call role entries instead.
const embeddedMulticallRolesPlugin = {
  name: "embedded-multicall-roles",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]cli[\\/]src[\\/]runtime[\\/](?:sidecar-role|tool-bridge-role|mcp-relay-role)\.ts$/ },
      (args) => {
        const role = path.basename(args.path, ".ts")
        if (role === "sidecar-role") {
          return {
            contents:
              'export async function runSidecarRole() { await import("../../../sidecar/claude-host.mjs") }',
            loader: "ts",
          }
        }
        if (role === "tool-bridge-role") {
          return {
            contents:
              'export async function runToolBridgeRole() { await import("../../../sidecar/cognia-tool-bridge.mjs") }',
            loader: "ts",
          }
        }
        return {
          contents:
            'export async function runMcpRelayRole() { const relay = await import("../../../sidecar/mcp-stdio-relay.mjs"); await relay.runMcpStdioRelay() }',
          loader: "ts",
        }
      }
    )
  },
}

const embeddedClaudeExecutablePlugin = {
  name: "embedded-claude-executable",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]sidecar[\\/]dispatch[\\/]claude-executable\.mjs$/ },
      () => ({
        contents: `
          import embeddedClaudePath from ${JSON.stringify(claudeBinary)} with { type: "file" };
          import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
          let extractedClaudePath;
          export function resolveEmbeddedClaudeExecutable() {
            return extractedClaudePath ??= extractFromBunfs(embeddedClaudePath);
          }
          export function applyEmbeddedClaudeExecutable(options, resolveExecutable = resolveEmbeddedClaudeExecutable) {
            const executable = resolveExecutable();
            return executable ? { ...options, pathToClaudeCodeExecutable: executable } : options;
          }
        `,
        loader: "js",
      })
    )
  },
}

const dynamicRequireCompatPlugin = {
  name: "dynamic-require-compat",
  setup(build) {
    build.onResolve({ filter: /^css-tree$/ }, () => ({
      path: path.join(root, "sidecar/webclone/node_modules/css-tree/dist/csstree.esm.js"),
    }))
    build.onResolve({ filter: /^@babel\/traverse$/ }, () => ({
      path: path.join(root, "sidecar/webclone/node_modules/@babel/traverse/lib/index.js"),
    }))
    build.onLoad(
      { filter: /[\\/]sidecar[\\/]webclone[\\/]dist[\\/]transform[\\/]js-analyzer\.js$/ },
      async (args) => {
        let source = await Bun.file(args.path).text()
        source = replaceExactly(
          source,
          'import { createRequire } from "node:module";\n',
          "",
          "webclone createRequire import"
        )
        source = replaceExactly(
          source,
          'const require = createRequire(import.meta.url);\nconst traverse = require("@babel/traverse").default;',
          'import traverseModule from "@babel/traverse";\nconst traverse = traverseModule.default;',
          "webclone Babel traversal binding"
        )
        return { contents: source, loader: "js" }
      }
    )
    build.onLoad(
      { filter: /[\\/]sidecar[\\/]builtin-tools[\\/]code[\\/]store-sqlite\.mjs$/ },
      async (args) => {
        const schema = await Bun.file(path.join(path.dirname(args.path), "schema.sql")).text()
        return {
          contents: replaceExactly(
            await Bun.file(args.path).text(),
            'const SCHEMA_SQL = fs.readFileSync(path.join(HERE, "schema.sql"), "utf-8")',
            `const SCHEMA_SQL = ${JSON.stringify(schema)}`,
            "codegraph schema inline"
          ),
          loader: "js",
        }
      }
    )
    build.onLoad({ filter: /[\\/]sidecar[\\/]agent-host\.mjs$/ }, async (args) => {
      const sdkPackage = JSON.parse(
        await Bun.file(path.join(root, "sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json")).text()
      )
      const sidecarPackage = JSON.parse(await Bun.file(path.join(root, "sidecar/package.json")).text())
      let source = await Bun.file(args.path).text()
      source = replaceExactly(
        source,
        'import { createRequire } from "node:module"\n',
        "",
        "agent host createRequire import"
      )
      source = replaceExactly(
        source,
        /const _require = createRequire\(import\.meta\.url\)\nfunction readVersionInfo\(\) \{[\s\S]*?\n\}/,
        `function readVersionInfo() { return ${JSON.stringify({ sdkVersion: sdkPackage.version, sidecarVersion: sidecarPackage.version })} }`,
        "agent host version metadata"
      )
      return { contents: source, loader: "js" }
    })
    build.onLoad({ filter: /[\\/]sidecar[\\/]lsp[\\/]service-loader\.mjs$/ }, async (args) => {
      let source = await Bun.file(args.path).text()
      source = replaceExactly(
        source,
        "import(pathToImportUrl(LSP_SERVICE_PATH))",
        'import("../vscode-ext-host/dist/lsp-service.js")',
        "LSP service static import"
      )
      source = replaceExactly(
        source,
        "import(pathToImportUrl(LSP_INSTALLER_PATH))",
        'import("../vscode-ext-host/dist/lsp-installer.js")',
        "LSP installer static import"
      )
      return { contents: source, loader: "js" }
    })
  },
}

const bundleAgentProtocolDependenciesPlugin = {
  name: "bundle-agent-protocol-dependencies",
  setup(build) {
    build.onResolve({ filter: /^valibot$/ }, () => ({
      path: path.join(root, "packages/agent/node_modules/valibot/dist/index.mjs"),
    }))
  },
}

// Bun 1.4.0 can mis-rename Zod 4.4's ESM re-exports when another bundled module
// has the same basename (for example `_endsWith` becomes an undefined
// `_endsWith2`). Zod publishes an equivalent CommonJS entry without that
// re-export shape, so select it only for this executable build.
const zodCommonJsPlugin = {
  name: "zod-commonjs-entry",
  setup(build) {
    build.onResolve({ filter: /^zod(?:\/.*)?$/ }, (args) => {
      const subpath = args.path === "zod" ? "" : args.path.slice("zod/".length)
      const candidate = path.join(root, "node_modules/zod", subpath, "index.cjs")
      return fs.existsSync(candidate) ? { path: candidate } : undefined
    })
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.resolveDir.includes(`${path.sep}node_modules${path.sep}zod${path.sep}`)) {
        return undefined
      }
      const candidate = path.resolve(args.resolveDir, args.path).replace(/\.js$/, ".cjs")
      return fs.existsSync(candidate) ? { path: candidate } : undefined
    })
  },
}

fs.rmSync(outdir, { recursive: true, force: true })
fs.mkdirSync(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  format: "esm",
  sourcemap: "none",
  minify: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  compile: {
    target: target.bunTarget,
    outfile,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  plugins: [
    createCliExternalAgentAliasPlugin(root),
    embeddedMulticallRolesPlugin,
    embeddedClaudeExecutablePlugin,
    dynamicRequireCompatPlugin,
    createTsconfigPathsPlugin(),
    bundleAgentProtocolDependenciesPlugin,
    zodCommonJsPlugin,
    stubRuntimePlugin,
    assetPlugin,
    jsonDefaultOnlyPlugin,
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

function copyRequired(source, destination, { executable = false } = {}) {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`build-cli-bun: required artifact is missing: ${path.relative(root, source)}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination)
  if (executable && target.name !== "win32-x64") fs.chmodSync(destination, 0o755)
}

copyRequired(externalHostLauncher, path.join(outdir, externalHostLauncherName), {
  executable: true,
})
copyRequired(workspaceHelper, path.join(outdir, workspaceHelperName), { executable: true })
copyRequired(
  path.join(root, "sidecar/pi-extension/cognia-pi-extension.ts"),
  path.join(outdir, "sidecar/pi-extension/cognia-pi-extension.ts")
)
copyRequired(
  path.join(root, "sidecar/pi-extension/integrity.json"),
  path.join(outdir, "sidecar/pi-extension/integrity.json")
)
copyRequired(
  path.join(root, "sidecar/node_modules/web-tree-sitter/tree-sitter.wasm"),
  path.join(outdir, "tree-sitter.wasm")
)
fs.cpSync(
  path.join(root, "sidecar/builtin-tools/code/grammars"),
  path.join(outdir, "grammars"),
  { recursive: true }
)

if (target.name !== "win32-x64") fs.chmodSync(outfile, 0o755)

const signingMode = signCliArtifacts({
  targetName: target.name,
  executable: outfile,
  nativeHelpers: [
    path.join(outdir, externalHostLauncherName),
    path.join(outdir, workspaceHelperName),
  ],
  entitlements: path.join(root, "scripts/build/bun-entitlements.plist"),
  identity: process.env.APPLE_SIGNING_IDENTITY ?? "",
})

const { TarArchive, ZipArchive } = await import("archiver")
const archiveFile = path.join(binDir, `${target.dist}.${target.archive}`)
fs.rmSync(archiveFile, { force: true })
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(archiveFile)
  const archive =
    target.archive === "zip"
      ? new ZipArchive({ zlib: { level: 9 } })
      : new TarArchive({ gzip: true, gzipOptions: { level: 9 } })
  output.on("close", resolve)
  archive.on("warning", (error) => (error.code === "ENOENT" ? undefined : reject(error)))
  archive.on("error", reject)
  archive.pipe(output)
  archive.directory(outdir, target.dist, (entry) => {
    if (target.archive !== "zip" && path.basename(entry.name) === target.executable) {
      entry.mode = 0o755
    }
    return entry
  })
  void archive.finalize()
})

const sizeMiB = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1)
console.log(
  `build-cli-bun: Bun ${Bun.version} wrote ${path.relative(root, outfile)} (${sizeMiB} MiB)`
)
if (signingMode) console.log(`build-cli-bun: ${signingMode} signed macOS artifacts`)
console.log(`build-cli-bun: archived ${path.relative(root, archiveFile)}`)
