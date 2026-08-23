/**
 * Verify the published tarball is what we claim it is.
 *
 * Three things are being proved here, and each one has failed before:
 *
 * 1. The package installs and imports through its *default* path. The previous
 *    version passed `--omit=optional`, which skipped the platform host packages
 *    entirely — so the one resolution path every real consumer takes was the
 *    one the test never exercised.
 * 2. The tarball is Apache-2.0 and carries no AGPL runtime. `@cognia/agent` is
 *    Apache-2.0 precisely because it is transport-only; the moment host source
 *    or a host binary lands inside it, the licence claim is false. That is a
 *    property of the artifact, so it is checked on the artifact.
 * 3. With a platform host present, the default `createCogniaClient()` starts a
 *    real host, opens a session, streams its events and shuts down.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "..")
const workspaceRoot = path.resolve(packageRoot, "../..")
const requireHost = process.argv.includes("--require-host")
const target = `${process.platform}-${process.arch}`
const hostPackageRoot = path.join(workspaceRoot, "packages", `agent-host-${target}`)
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-pack-"))

function pack(cwd) {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--silent", "--pack-destination", tempRoot],
    {
      cwd,
      encoding: "utf8",
    }
  )
  const start = output.startsWith("[") ? 0 : output.lastIndexOf("\n[") + 1
  if (start < 0) throw new Error(`npm pack did not emit JSON:\n${output}`)
  return path.join(tempRoot, JSON.parse(output.slice(start))[0].filename)
}

/** The built host binary for this platform, or null when it was never built. */
function resolveLocalHost() {
  if (!fs.existsSync(hostPackageRoot)) return null
  const manifest = JSON.parse(fs.readFileSync(path.join(hostPackageRoot, "package.json"), "utf8"))
  const binary = manifest.bin?.["cognia-agent"]
  if (!binary) return null
  return fs.existsSync(path.join(hostPackageRoot, binary)) ? hostPackageRoot : null
}

try {
  execFileSync(path.join(workspaceRoot, "node_modules/.bin/tsup"), [], {
    cwd: packageRoot,
    stdio: "inherit",
  })
  const tarball = pack(packageRoot)

  // ---- Artifact claims -----------------------------------------------------
  const packedFiles = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
  if (packedFiles.includes("src/") || packedFiles.includes("@/")) {
    throw new Error("packed SDK contains source files or unresolved app aliases")
  }
  if (!packedFiles.split("\n").some((entry) => entry.endsWith("/LICENSE"))) {
    throw new Error("packed SDK ships no LICENSE; Apache-2.0 requires it")
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  if (manifest.license !== "Apache-2.0") {
    throw new Error(`packed SDK declares license ${manifest.license}, expected Apache-2.0`)
  }
  const licenceText = fs.readFileSync(path.join(packageRoot, "LICENSE"), "utf8")
  if (!licenceText.includes("Apache License")) {
    throw new Error("packages/agent/LICENSE is not the Apache License text")
  }
  if (/AFFERO|GNU GENERAL PUBLIC/i.test(licenceText)) {
    throw new Error("packages/agent/LICENSE carries copyleft text; the client must stay Apache-2.0")
  }
  // The host is a separate, AGPL package. Nothing executable from it may ride
  // along inside the Apache-2.0 client tarball.
  const smuggled = packedFiles
    .split("\n")
    .filter((entry) => /(^|\/)(bin|cognia-agent)(\/|$)/.test(entry.trim()) && entry.trim())
  if (smuggled.length > 0) {
    throw new Error(`packed SDK smuggles host artifacts: ${smuggled.join(", ")}`)
  }
  for (const optional of Object.keys(manifest.optionalDependencies ?? {})) {
    const range = manifest.optionalDependencies[optional]
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range)) {
      throw new Error(
        `optional host ${optional} is pinned to "${range}"; hosts must be exact so a ` +
          "client never resolves a host built from a different protocol revision"
      )
    }
  }

  // ---- Default-path install ------------------------------------------------
  const localHost = resolveLocalHost()
  const consumer = path.join(tempRoot, "consumer")
  fs.mkdirSync(consumer)
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "agent-sdk-consumer", private: true, type: "module" })
  )
  // No `--omit=optional`: this is the resolution every real consumer gets. An
  // unpublished optional host simply does not resolve, which is also real.
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
      ...(localHost ? [pack(localHost)] : []),
    ],
    { cwd: consumer, stdio: "inherit" }
  )

  fs.writeFileSync(
    path.join(consumer, "esm.mjs"),
    'import { createCogniaClient } from "@cognia/agent"; import { validateHandoffEnvelope } from "@cognia/agent/handoff-envelope"; if (typeof createCogniaClient !== "function" || typeof validateHandoffEnvelope !== "function") process.exit(1)\n'
  )
  fs.writeFileSync(
    path.join(consumer, "cjs.cjs"),
    'const { createCogniaClient } = require("@cognia/agent"); const { validateHandoffEnvelope } = require("@cognia/agent/handoff-envelope"); if (typeof createCogniaClient !== "function" || typeof validateHandoffEnvelope !== "function") process.exit(1)\n'
  )
  fs.writeFileSync(
    path.join(consumer, "types.ts"),
    'import type { CogniaClient, AgentRunHandle } from "@cognia/agent"; import type { RpcMethodMap } from "@cognia/agent/protocol"; import type { HandoffEnvelope } from "@cognia/agent/handoff-envelope"; declare const client: CogniaClient; declare const run: AgentRunHandle; declare const map: RpcMethodMap; declare const handoff: HandoffEnvelope; void client; void run; void map; void handoff\n'
  )
  fs.writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["types.ts"],
    })
  )
  execFileSync(process.execPath, [path.join(consumer, "esm.mjs")], { stdio: "inherit" })
  execFileSync(process.execPath, [path.join(consumer, "cjs.cjs")], { stdio: "inherit" })
  execFileSync(path.join(workspaceRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
    cwd: consumer,
    stdio: "inherit",
  })

  // ---- Real host, resolved the default way ---------------------------------
  if (!localHost) {
    const message =
      `no built host at packages/agent-host-${target}; the default-resolution leg did not run. ` +
      "Build it with `pnpm agent:host:package -- " +
      target +
      "` first."
    if (requireHost) throw new Error(message)
    process.stdout.write(`[pack-test] SKIPPED default-host leg: ${message}\n`)
  } else {
    fs.writeFileSync(
      path.join(consumer, "host.mjs"),
      `import { createCogniaClient } from "@cognia/agent"
// No host option: this is the default resolution path, which is the whole point.
const client = await createCogniaClient()
try {
  const status = await client.runtime.status()
  if (status.status !== "ready") throw new Error("host did not become ready")
  if (!client.runtime.info.capabilities.some((c) => /-v\\d+$/.test(c))) {
    throw new Error("host declared no versioned capabilities")
  }
  const session = await client.sessions.create({ name: "pack-test" })
  const seen = []
  const stream = session.events({ capacity: 64 })
  const drain = (async () => {
    for await (const envelope of stream) {
      seen.push(envelope.eventId)
      if (seen.length >= 1) break
    }
  })()
  const state = await session.state()
  if (typeof state.status !== "string") throw new Error("session state is not reportable")
  await session.close()
  await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 2000))])
} finally {
  await client.close()
}
`
    )
    execFileSync(process.execPath, [path.join(consumer, "host.mjs")], {
      cwd: consumer,
      stdio: "inherit",
      timeout: 90_000,
    })
    process.stdout.write("[pack-test] default-resolution host boot passed\n")
  }

  console.log("@cognia/agent packed-consumer test passed")
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
