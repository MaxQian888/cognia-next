#!/usr/bin/env node
/**
 * Dist-only consumption proof, isolated from the workspace and network.
 * Builds sibling artifacts into temporary output directories, never into their
 * working trees. Staged manifests normalize workspace ranges exactly as pnpm
 * pack would; npm pack/install then run with scripts disabled and offline.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(packageRoot, "../..")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-omp-pack-"))
const consumer = path.join(tempRoot, "consumer")
const tarballs = path.join(tempRoot, "tarballs")
const tsup = path.join(repoRoot, "node_modules/.bin/tsup")
const tsc = path.join(repoRoot, "node_modules/.bin/tsc")
const snapshots = new Map()
fs.mkdirSync(consumer)
fs.mkdirSync(tarballs)

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_cache: path.join(tempRoot, "npm-cache"),
      npm_config_update_notifier: "false",
    },
  })
}
function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? files(target) : [target]
  })
}
function installedDirectory(name, from) {
  const require = createRequire(path.join(from, "package.json"))
  let file
  try {
    file = require.resolve(`${name}/package.json`)
  } catch {
    file = require.resolve(name)
  }
  let directory = path.dirname(file)
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json")
    if (fs.existsSync(manifest) && json(manifest).name === name) return directory
    directory = path.dirname(directory)
  }
  throw new Error(`Cannot find installed package ${name}`)
}

function stage(name, from = repoRoot) {
  if (snapshots.has(name)) return snapshots.get(name)
  const source = name.startsWith("@cognia/")
    ? path.join(repoRoot, "packages", name.slice("@cognia/".length))
    : installedDirectory(name, from)
  const manifest = json(path.join(source, "package.json"))
  const directory = path.join(tempRoot, "staged", name.replaceAll("/", "__"))
  fs.mkdirSync(directory, { recursive: true })
  const snapshot = { source, manifest, directory }
  snapshots.set(name, snapshot)

  if (name.startsWith("@cognia/")) {
    // Target build belongs to this task. Sibling builds write only beneath tempRoot.
    if (name === "@cognia/agent-omp") {
      run(tsup, [], source)
      fs.cpSync(path.join(source, "dist"), path.join(directory, "dist"), { recursive: true })
    } else {
      run(tsup, ["--out-dir", path.join(directory, "dist")], source)
    }
    for (const file of ["LICENSE", "README.md", "THIRD_PARTY_LICENSES"]) {
      if (fs.existsSync(path.join(source, file)))
        fs.copyFileSync(path.join(source, file), path.join(directory, file))
    }
  } else {
    // Only installed public package contents, with no symlink to the workspace.
    fs.cpSync(source, directory, {
      recursive: true,
      dereference: true,
      filter: (file) => path.basename(file) !== "node_modules",
    })
  }
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
  for (const [dependency] of Object.entries(dependencies)) {
    if (
      manifest.peerDependenciesMeta?.[dependency]?.optional &&
      !manifest.dependencies?.[dependency]
    )
      continue
    const dependencySnapshot = stage(dependency, source)
    if (manifest.dependencies?.[dependency]?.startsWith("workspace:")) {
      manifest.dependencies[dependency] = dependencySnapshot.manifest.version
    }
  }
  // Packaging never executes source-repository hooks or installs dev tooling.
  delete manifest.devDependencies
  writeJson(path.join(directory, "package.json"), manifest)
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballs], directory)
  )[0]
  snapshot.tarball = path.join(tarballs, packed.filename)
  snapshot.packedFiles = packed.files.map((file) => file.path)
  return snapshot
}

try {
  const target = stage("@cognia/agent-omp")
  stage("@types/node")
  if (!target.packedFiles.includes("THIRD_PARTY_LICENSES"))
    throw new Error("OMP tarball omits required THIRD_PARTY_LICENSES")
  if (
    !target.packedFiles.includes("dist/index.js") ||
    target.packedFiles.some((file) => file.startsWith("src/"))
  ) {
    throw new Error("OMP tarball must ship dist without source entry points")
  }
  for (const file of files(path.join(target.directory, "dist")).filter((file) =>
    /\.(?:[cm]?js|d\.[cm]?ts)$/.test(file)
  )) {
    const text = fs.readFileSync(file, "utf8")
    const imports = [
      ...text.matchAll(/(?:from\s*|import\s*\(|require\s*\(|import\s+)["']([^"']+)["']/g),
    ].map((match) => match[1])
    const forbidden = imports.find((specifier) =>
      /^(?:@\/|bun(?:$|:)|@oh-my-pi\/|@earendil-works\/|@cognia\/agent-pi(?:$|\/)|@tauri-apps\/)/.test(
        specifier
      )
    )
    if (forbidden)
      throw new Error(`${path.basename(file)} imports forbidden dependency ${forbidden}`)
  }
  writeJson(path.join(consumer, "package.json"), {
    name: "omp-independent-consumer",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      [...snapshots].map(([name, snapshot]) => [name, `file:${snapshot.tarball}`])
    ),
  })
  run(
    "npm",
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
    consumer
  )

  const entries = [
    "@cognia/agent-omp",
    ...files(path.join(target.directory, "dist"))
      .filter((file) => file.endsWith(".cjs") && !path.basename(file).startsWith("chunk-"))
      .map(
        (file) =>
          `@cognia/agent-omp/${path.relative(path.join(target.directory, "dist"), file).replace(/\.cjs$/, "")}`
      ),
  ]
  fs.writeFileSync(
    path.join(consumer, "entries.mjs"),
    entries.map((entry) => `await import(${JSON.stringify(entry)})`).join("\n")
  )
  fs.writeFileSync(
    path.join(consumer, "entries.cjs"),
    entries.map((entry) => `require(${JSON.stringify(entry)})`).join("\n")
  )
  run(process.execPath, ["entries.mjs"], consumer)
  run(process.execPath, ["entries.cjs"], consumer)
  for (const entry of ["manifest", "history", "config", "wire"]) {
    fs.writeFileSync(
      path.join(consumer, "closure.cjs"),
      `
      require('@cognia/agent-omp/${entry}');
      const forbidden = Object.keys(require.cache).filter(file => /(?:rpc-client|rpc-peer|native-guard|host-requests|base-adapter)\\.cjs$/.test(file));
      if (forbidden.length) throw new Error('Data-only entry loads runtime: ' + forbidden.join(', '));
    `
    )
    run(process.execPath, ["closure.cjs"], consumer)
  }
  const types = `
    import { OmpSessionClient } from '@cognia/agent-omp/session-client';
    import type { OmpCommandMap } from '@cognia/agent-omp/wire';
    import { OmpRpcPeer } from '@cognia/agent-omp/rpc-peer';
    import { ompManifest } from '@cognia/agent-omp/manifest';
    const peer = new OmpRpcPeer({ send: async () => {}, outboundGate: () => true });
    const client = new OmpSessionClient({ request: (type, ...args) => peer.request(type, ...args), prompt: (params, type) => peer.prompt(params, type) });
    const state: Promise<OmpCommandMap['get_state']['result']> = client.getState();
    const tools: Promise<OmpCommandMap['set_host_tools']['result']> = client.setHostTools({ tools: [] });
    void [state, tools, ompManifest];
    peer.dispose();
  `
  fs.writeFileSync(path.join(consumer, "consumer.mts"), types)
  fs.writeFileSync(path.join(consumer, "consumer.cts"), types)
  writeJson(path.join(consumer, "tsconfig.json"), {
    compilerOptions: {
      strict: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    files: ["consumer.mts", "consumer.cts"],
  })
  run(tsc, ["--project", "tsconfig.json"], consumer)
  console.log(
    `[pack-test] PASS: ${entries.length} exports imported via ESM/CJS; 4 data-only closures; strict NodeNext ESM/CJS; ${snapshots.size} offline tarballs; no workspace links`
  )
  if (process.env.OMP_KEEP_PACKED === "1") console.log(`[pack-test] Consumer retained: ${consumer}`)
  else fs.rmSync(tempRoot, { recursive: true, force: true })
} catch (error) {
  console.error(error.stdout ?? "")
  console.error(error.stderr ?? "")
  console.error(`[pack-test] FAIL: ${error.message}; artifacts preserved at ${tempRoot}`)
  process.exitCode = 1
}
