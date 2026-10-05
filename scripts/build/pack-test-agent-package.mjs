#!/usr/bin/env node
/**
 * Prove an agent package works as an installed artifact, not as monorepo
 * source (ADR-0217).
 *
 * For `@cognia/<name>` this:
 *
 * 1. builds the package and every `@cognia/*` package it depends on
 *    (transitively), then `pnpm pack`s each one — `pnpm pack` rewrites
 *    `workspace:*`, so the tarballs carry real version ranges;
 * 2. checks the target tarball: `dist/` present, no `src/`, a LICENSE, and no
 *    declaration file naming an app-private `@/` path;
 * 3. installs ONLY tarballs into a fresh consumer outside the repo (overrides
 *    pin every unpublished `@cognia/*` dependency to its tarball — no `link:`,
 *    no workspace symlink can satisfy an import);
 * 4. imports every declared entry point through ESM and CJS, runs the
 *    package's runtime smoke, type-checks a NodeNext consumer with strict
 *    `tsc`, and asserts each "data-only" entry point loads none of the
 *    package's runtime modules.
 *
 * Usage: node scripts/build/pack-test-agent-package.mjs <package-dir-name> | --all
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "../..")
const requested = process.argv[2]
if (!requested) {
  console.error("usage: pack-test-agent-package.mjs <package-dir-name> | --all")
  process.exit(2)
}

/**
 * Per-package consumer checks. `entries` are imported through ESM and CJS.
 * `dataOnly` entries must not load any module whose path matches one of
 * `runtimeModules` (proved through the CJS module cache). `smoke` is an ESM
 * program run in the consumer; `types` is a strict NodeNext TypeScript file.
 */
const SPECS = {
  "agent-contracts": {
    entries: [
      ".",
      "./adapter",
      "./adapter-extension",
      "./semantics",
      "./host",
      "./ecosystem",
      "./external-agent",
      "./session-operations",
      "./canonical-event",
      "./canonical-session",
      "./history",
    ],
    dataOnly: [],
    runtimeModules: [],
    smoke: `
      import { UNDECLARED_EXECUTION_SEMANTICS, requiresReconnectAfterCancel } from "@cognia/agent-contracts/semantics"
      import { missingAdapterCoreMethods } from "@cognia/agent-contracts/adapter"
      import { defineAdapterExtension } from "@cognia/agent-contracts/adapter-extension"
      if (!requiresReconnectAfterCancel(UNDECLARED_EXECUTION_SEMANTICS)) throw new Error("semantics")
      if (missingAdapterCoreMethods({}).length !== 12) throw new Error("core methods")
      if (defineAdapterExtension("vendor.x", () => undefined).id !== "vendor.x") throw new Error("extension")
      import { isAgentEventEnvelope } from "@cognia/agent-contracts/canonical-event"
      import { validateCanonicalSession } from "@cognia/agent-contracts/canonical-session"
      if (isAgentEventEnvelope({ schemaVersion: 1 })) throw new Error("envelope")
      if (validateCanonicalSession({}).length === 0) throw new Error("canonical session")
    `,
    types: `
      import type { ProtocolAdapter, SessionCreateOptions } from "@cognia/agent-contracts/adapter"
      import type { AgentProcessHost } from "@cognia/agent-contracts/host"
      import type { ExternalAgentEvent } from "@cognia/agent-contracts/external-agent"
      import { executionSemanticsOf } from "@cognia/agent-contracts/semantics"
      declare const adapter: ProtocolAdapter
      declare const host: AgentProcessHost
      const options: SessionCreateOptions = { cwd: "/w", permissionMode: "plan" }
      const scope: "turn" | "session" | "process" = executionSemanticsOf(adapter).cancel.scope
      const spawned: Promise<string> = host.spawn({ id: "a", command: "agent" })
      const event: ExternalAgentEvent["type"] = "done"
      import type { ParsedHistorySession, HistoryPart } from "@cognia/agent-contracts/history"
      import type { CanonicalAgentEvent } from "@cognia/agent-contracts/canonical-event"
      declare const parsed: ParsedHistorySession
      const firstPart: HistoryPart | undefined = parsed.messages[0]?.parts[0]
      const canonical: CanonicalAgentEvent["kind"] = "text-delta"
      export { options, scope, spawned, event, firstPart, canonical }
    `,
  },
  "agent-runtime-kit": {
    entries: [
      ".",
      "./base-adapter",
      "./json-rpc-peer",
      "./lf-frame-decoder",
      "./spawn-reclaim",
      "./history",
    ],
    dataOnly: ["./history"],
    runtimeModules: ["base-adapter", "json-rpc-peer", "lf-frame-decoder", "spawn-reclaim"],
    smoke: `
      import { LfFrameDecoder } from "@cognia/agent-runtime-kit/lf-frame-decoder"
      import { JsonRpcPeer } from "@cognia/agent-runtime-kit/json-rpc-peer"
      const frames = new LfFrameDecoder({ label: "smoke" }).push('{"a":1}\\n{"b":')
      if (frames.length !== 1) throw new Error("decoder")
      const sent = []
      const peer = new JsonRpcPeer({ writeRaw: async (m) => { sent.push(m) } })
      const reply = peer.sendRequest("ping", {}, 1000)
      peer.ingest(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(sent[0]).id, result: "pong" }))
      if ((await reply) !== "pong") throw new Error("peer")
      import { boundedDiagnostic, importedSessionId } from "@cognia/agent-runtime-kit/history"
      if (importedSessionId("codex", "a") !== "import:codex:a") throw new Error("history ids")
      if (boundedDiagnostic({ api_key: "k" }, { redactText: (t) => t }).api_key !== "[redacted]") throw new Error("diagnostic")
    `,
    types: `
      import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
      import type { ExternalAgentAdapterCore } from "@cognia/agent-contracts/adapter"
      declare const adapter: BaseProtocolAdapter
      const core: ExternalAgentAdapterCore = adapter
      export { core }
    `,
  },
  "agent-dsh": {
    entries: [".", "./manifest", "./sdk-client", "./transport", "./channel", "./install"],
    dataOnly: ["./manifest"],
    runtimeModules: ["sdk-client", "transport", "event-codec", "agent-runtime-kit"],
    smoke: `
      import { deepseekHarnessManifest, DSH_SDK_EXECUTION_SEMANTICS } from "@cognia/agent-dsh/manifest"
      import { DshSdkClientAdapter } from "@cognia/agent-dsh/sdk-client"
      import { createDshRuntimeTransport, resolveDshLaunchFromConfig } from "@cognia/agent-dsh/transport"
      if (deepseekHarnessManifest.ecosystem.id !== "deepseek-harness") throw new Error("manifest")
      const adapter = new DshSdkClientAdapter({ createTransport: () => { throw new Error("unused") } })
      if (adapter.protocol !== "dsh-sdk" || adapter.semantics !== DSH_SDK_EXECUTION_SEMANTICS) throw new Error("adapter")
      let refused = false
      try {
        createDshRuntimeTransport({ id: "x" }, resolveDshLaunchFromConfig, { available: false }, () => true)
      } catch { refused = true }
      if (!refused) throw new Error("an unavailable process host must be refused")
    `,
    types: `
      import { DshSdkClientAdapter, type DshRuntimeTransport } from "@cognia/agent-dsh/sdk-client"
      import { createDshRuntimeTransport, resolveDshLaunchFromConfig } from "@cognia/agent-dsh/transport"
      import type { AgentProcessHost } from "@cognia/agent-contracts/host"
      import type { ProtocolAdapter } from "@cognia/agent-contracts/adapter"
      declare const host: AgentProcessHost
      const adapter: ProtocolAdapter = new DshSdkClientAdapter({
        createTransport: (config): DshRuntimeTransport =>
          createDshRuntimeTransport(config, resolveDshLaunchFromConfig, host, () => true),
      })
      export { adapter }
    `,
  },
  "agent-codex": {
    entries: [
      ".",
      "./manifest",
      "./history",
      "./app-server-client",
      "./mcp-config",
      "./config-requirements",
    ],
    dataOnly: ["./manifest", "./history"],
    runtimeModules: [
      "app-server-client",
      "base-adapter",
      "json-rpc-peer",
      "lf-frame-decoder",
      "spawn-reclaim",
    ],
    smoke: `
      import { codexManifest, CODEX_APP_SERVER_EXECUTION_SEMANTICS } from "@cognia/agent-codex/manifest"
      import { CodexAppServerAdapter, codexAppServerExtension } from "@cognia/agent-codex/app-server-client"
      if (codexManifest.ecosystem.runtimeIds.join() !== "codex-acp,codex-app-server") throw new Error("manifest")
      const host = { available: false }
      const adapter = new CodexAppServerAdapter({ processHost: host, resolveLaunchEnvironment: async () => ({}), approvalPolicy: () => null, outboundGate: () => true })
      if (adapter.semantics !== CODEX_APP_SERVER_EXECUTION_SEMANTICS) throw new Error("semantics")
      if (codexAppServerExtension.resolve(adapter) !== adapter) throw new Error("extension")
      let refused = false
      try {
        await adapter.connect({ id: "c", name: "c", protocol: "codex-app-server", transport: "stdio", process: { command: "codex" } })
      } catch (error) { refused = /process host/.test(String(error)) }
      if (!refused) throw new Error("connect must refuse without a process host")
      import { parseCodexRollout } from "@cognia/agent-codex/history"
      const rollout = [
        JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }),
      ].join("\\n")
      const parsed = parseCodexRollout(rollout, "r.jsonl", { redactText: (t) => t })
      if (parsed.originalSessionId !== "s1" || parsed.messages[0]?.parts[0]?.type !== "text") throw new Error("history")
    `,
    types: `
      import { CodexAppServerAdapter, type CodexAppServerStatus } from "@cognia/agent-codex/app-server-client"
      import type { AgentProcessHost } from "@cognia/agent-contracts/host"
      import type { ProtocolAdapter } from "@cognia/agent-contracts/adapter"
      declare const host: AgentProcessHost
      const adapter: ProtocolAdapter = new CodexAppServerAdapter({
        processHost: host,
        resolveLaunchEnvironment: async (_config, base) => base,
        approvalPolicy: () => null,
        outboundGate: () => true,
      })
      declare const status: CodexAppServerStatus
      import { parseCodexRollout, summarizeCodexRollout } from "@cognia/agent-codex/history"
      import type { ParsedHistorySession, HistorySessionSummary } from "@cognia/agent-contracts/history"
      const parsed: ParsedHistorySession = parseCodexRollout("", "r", { redactText: (t) => t })
      const summary: HistorySessionSummary | null = summarizeCodexRollout("", "r")
      export { adapter, status, parsed, summary }
    `,
  },
}


function run(command, args, cwd, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, pnpm_config_verify_deps_before_run: "false", ...extraEnv },
  })
}

function readManifest(dirName) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", dirName, "package.json"), "utf8"))
}

/** Every `@cognia/*` package reachable through `dependencies`, target first. */
function closure(dirName, seen = new Map()) {
  if (seen.has(dirName)) return seen
  const manifest = readManifest(dirName)
  seen.set(dirName, manifest)
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep.startsWith("@cognia/")) closure(dep.slice("@cognia/".length), seen)
  }
  return seen
}

/** Pack, install and exercise one package. Resolves false (and keeps the consumer) on failure. */
function packTest(target) {
  const spec = SPECS[target]
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cognia-${target}-pack-`))
  const tarballDir = path.join(tempRoot, "tarballs")
  const consumer = path.join(tempRoot, "consumer")
  fs.mkdirSync(tarballDir)
  fs.mkdirSync(consumer)

  try {
    const packages = closure(target)
    const tarballs = new Map()
    for (const [dirName, manifest] of packages) {
      const dir = path.join(repoRoot, "packages", dirName)
      if (manifest.scripts?.build) run("pnpm", ["run", "build"], dir)
      const before = new Set(fs.readdirSync(tarballDir))
      run("pnpm", ["pack", "--pack-destination", tarballDir], dir)
      const produced = fs.readdirSync(tarballDir).find((file) => !before.has(file))
      if (!produced) throw new Error(`pnpm pack produced no tarball for ${manifest.name}`)
      tarballs.set(manifest.name, path.join(tarballDir, produced))
    }

    // Artifact checks on the target tarball.
    const targetName = readManifest(target).name
    const listing = run("tar", ["-tzf", tarballs.get(targetName)], tempRoot).split("\n")
    if (!listing.some((entry) => entry.startsWith("package/dist/")))
      throw new Error(`${targetName}: tarball has no dist/`)
    if (listing.some((entry) => entry.startsWith("package/src/")))
      throw new Error(`${targetName}: tarball ships src/`)
    if (!listing.includes("package/LICENSE")) throw new Error(`${targetName}: tarball has no LICENSE`)
    const unpacked = path.join(tempRoot, "unpacked")
    fs.mkdirSync(unpacked)
    run("tar", ["-xzf", tarballs.get(targetName), "-C", unpacked], tempRoot)
    for (const entry of listing.filter((name) => /\.d\.c?ts$/.test(name))) {
      const text = fs.readFileSync(path.join(unpacked, entry), "utf8")
      if (/from ["']@\//.test(text) || /import\(["']@\//.test(text))
        throw new Error(`${targetName}: ${entry} names an app-private @/ path`)
    }
    const packedManifest = JSON.parse(
      fs.readFileSync(path.join(unpacked, "package", "package.json"), "utf8")
    )
    for (const [dep, range] of Object.entries(packedManifest.dependencies ?? {})) {
      if (String(range).startsWith("workspace:"))
        throw new Error(`${targetName}: packed dependency ${dep} still says ${range}`)
    }

    // A consumer that can only see tarballs.
    const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    const installed = (name) =>
      JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", name, "package.json"), "utf8"))
        .version
    const peerDeps = Object.keys(packedManifest.peerDependencies ?? {})
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "agent-package-consumer",
          private: true,
          type: "module",
          packageManager: rootManifest.packageManager,
          dependencies: {
            ...Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`])),
            ...Object.fromEntries(peerDeps.map((name) => [name, installed(name)])),
            typescript: installed("typescript"),
            "@types/node": installed("@types/node"),
          },
        },
        null,
        2
      )}\n`
    )
    fs.writeFileSync(
      path.join(consumer, "pnpm-workspace.yaml"),
      [
        "packages: []",
        "overrides:",
        ...[...tarballs.entries()].map(([name, file]) => `  "${name}": "file:${file}"`),
        "",
      ].join("\n")
    )
    run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumer)

    // Every entry through ESM and CJS.
    const subpath = (entry) => (entry === "." ? targetName : `${targetName}/${entry.slice(2)}`)
    fs.writeFileSync(
      path.join(consumer, "entries.mjs"),
      spec.entries.map((entry) => `await import(${JSON.stringify(subpath(entry))})`).join("\n") +
        "\n"
    )
    run("node", ["entries.mjs"], consumer)
    fs.writeFileSync(
      path.join(consumer, "entries.cjs"),
      spec.entries.map((entry) => `require(${JSON.stringify(subpath(entry))})`).join("\n") + "\n"
    )
    run("node", ["entries.cjs"], consumer)

    // Data-only entries load no runtime module.
    for (const entry of spec.dataOnly) {
      fs.writeFileSync(
        path.join(consumer, "closure.cjs"),
        [
          `require(${JSON.stringify(subpath(entry))})`,
          `const loaded = Object.keys(require.cache)`,
          `const runtime = ${JSON.stringify(spec.runtimeModules)}`,
          `const leaked = loaded.filter((file) => runtime.some((name) => file.includes(name)))`,
          `if (leaked.length) { console.error(leaked.join("\\n")); process.exit(1) }`,
          "",
        ].join("\n")
      )
      try {
        run("node", ["closure.cjs"], consumer)
      } catch (error) {
        throw new Error(`${subpath(entry)} loads runtime modules:\n${error.stderr ?? error}`)
      }
    }

    // Runtime smoke.
    fs.writeFileSync(path.join(consumer, "smoke.mjs"), `${spec.smoke.trim()}\n`)
    run("node", ["smoke.mjs"], consumer)

    // Strict NodeNext types.
    fs.writeFileSync(path.join(consumer, "consumer.ts"), `${spec.types.trim()}\n`)
    fs.writeFileSync(
      path.join(consumer, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            noEmit: true,
            skipLibCheck: false,
            types: ["node"],
          },
          files: ["consumer.ts"],
        },
        null,
        2
      )}\n`
    )
    run(path.join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumer)

    console.log(
      `[pack-test] ${targetName}: tarball installed with ${tarballs.size - 1} packed @cognia dependenc${
        tarballs.size === 2 ? "y" : "ies"
      }; ${spec.entries.length} entries load (ESM+CJS); ${spec.dataOnly.length} data-only closure check(s); smoke and NodeNext tsc pass`
    )
  } catch (error) {
    console.error(`[pack-test] ${target} FAILED`)
    console.error(error.stdout ?? "")
    console.error(error.stderr ?? "")
    console.error(error.message ?? error)
    console.error(`[pack-test] consumer kept at ${tempRoot}`)
    return false
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
  return true
}

const targets = requested === "--all" ? Object.keys(SPECS) : [requested]
const unknown = targets.filter((name) => !SPECS[name])
if (unknown.length) {
  console.error(`No pack-test spec for ${unknown.join(", ")}. Known: ${Object.keys(SPECS).join(", ")}`)
  process.exit(2)
}
let failed = 0
for (const target of targets) if (!packTest(target)) failed += 1
process.exit(failed ? 1 : 0)
