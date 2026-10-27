// Node-only entry points need their own staged closure: the renderer must never
// import an SDK, and an external SDK import must still work outside this repo.
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildSync, version as esbuildVersion } from "esbuild"
import { copyRuntimeClosure, findInstalledPackage } from "./copy-runtime-closure.mjs"

export const NATIVE_AGENT_BRIDGES = Object.freeze({
  codebuff: { source: "packages/agent-codebuff/src/node-bridge.ts", args: ["--cognia-codebuff-bridge"] },
  "crush-http": { source: "packages/agent-crush/src/node-bridge.ts", args: ["--cognia-crush-bridge"] },
  "hermes-probe": { source: "cli/src/runtime/external/hermes-gateway-probe.ts", args: ["--hermes-gateway-probe"] },
  "hermes-acp": { source: "cli/src/runtime/external/hermes-acp-bridge.ts", args: ["--cognia-hermes-acp"] },
})
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const json = (value) => JSON.stringify(value, null, 2) + "\n"

function inventory(dir, prefix = "") {
  const files = {}
  for (const name of fs.readdirSync(dir).sort()) {
    const relative = prefix + name
    const file = path.join(dir, name)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error(`native bridge staging refuses symlink: ${relative}`)
    if (stat.isDirectory()) Object.assign(files, inventory(file, relative + "/"))
    else if (stat.isFile()) files[relative] = digest(fs.readFileSync(file))
    else throw new Error(`native bridge staging refuses non-file: ${relative}`)
  }
  return files
}

/** Build in isolation, then replace the owned native-agents folder.
 * `pin` is an explicit maintainer operation; ordinary staging never updates pins.
 * Pins are embedded into each host binary, independently of adjacent metadata.
 */
export function stageNativeAgentBridges({ root, sidecarOutDir, pin = false } = {}) {
  if (!root || !sidecarOutDir) throw new Error("native bridge staging requires root and sidecarOutDir")
  root = fs.realpathSync(root)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-native-bridges-"))
  try {
    const sources = {}
    const bridges = {}
    const addSource = (relative) => {
      if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`source escapes repository: ${relative}`)
      const file = path.join(root, relative)
      if (fs.lstatSync(file).isSymbolicLink() || !fs.realpathSync(file).startsWith(root + path.sep))
        throw new Error(`source path escapes repository: ${relative}`)
      sources[relative] = digest(fs.readFileSync(file))
    }
    for (const [id, spec] of Object.entries(NATIVE_AGENT_BRIDGES)) {
      addSource(spec.source)
      const file = `${id}.cjs`
      const result = buildSync({
        absWorkingDir: root, entryPoints: [spec.source], outfile: file,
        bundle: true, write: false, metafile: true, platform: "node", format: "cjs",
        target: "node26", external: ["@codebuff/sdk"], logLevel: "silent",
      })
      const bytes = result.outputFiles[0].contents
      fs.writeFileSync(path.join(scratch, file), bytes)
      bridges[id] = { file, args: spec.args, sha256: digest(bytes) }
      for (const input of Object.keys(result.metafile.inputs)) addSource(input)
    }
    const sdkFrom = path.join(root, "packages/agent-codebuff")
    const sdkRoot = findInstalledPackage("@codebuff/sdk", sdkFrom)
    if (!sdkRoot) throw new Error("missing installed @codebuff/sdk@0.10.7; install the pinned workspace lockfile")
    const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"))
    if (sdk.version !== "0.10.7") throw new Error(`expected installed @codebuff/sdk@0.10.7, found ${sdk.version}`)
    copyRuntimeClosure({ names: ["@codebuff/sdk"], fromDir: sdkFrom, destNodeModules: path.join(scratch, "node_modules") })
    for (const input of ["packages/agent-codebuff/package.json", "pnpm-lock.yaml", "scripts/build/lib/stage-native-agent-bridges.mjs", "scripts/build/lib/copy-runtime-closure.mjs"])
      if (fs.existsSync(path.join(root, input))) addSource(input)
    const files = inventory(scratch)
    const dependencyFiles = Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith("node_modules/")))
    const manifest = {
      schemaVersion: 1, esbuildVersion, sdk: { name: "@codebuff/sdk", version: sdk.version },
      sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b, "en"))),
      bridges, dependencyFiles,
    }
    const pinsPath = path.join(root, "sidecar/native-agents/pins.json")
    if (!pin) {
      let expected
      try { expected = JSON.parse(fs.readFileSync(pinsPath, "utf8")) } catch { throw new Error("native bridge pins missing; run build-native-agent-bridges.mjs --pin after reviewing sources") }
      if (json(expected) !== json(manifest)) throw new Error("native bridge source, compiled output, or dependency inventory differs from embedded pins; review and explicitly --pin")
    }
    fs.writeFileSync(path.join(scratch, "integrity.json"), json(manifest))
    const destination = path.join(sidecarOutDir, "native-agents")
    fs.mkdirSync(sidecarOutDir, { recursive: true })
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("native bridge destination is a symlink")
    // Keep checked-in pins when staging into the source sidecar directory.
    fs.writeFileSync(path.join(scratch, "pins.json"), json(manifest))
    // Do not churn thousands of watched dependency files on every predev. Verify
    // the entire closure before reusing it; extra/tampered files still replace it.
    if (!fs.existsSync(destination) || json(inventory(destination)) !== json(inventory(scratch))) {
      fs.rmSync(destination, { recursive: true, force: true })
      fs.cpSync(scratch, destination, { recursive: true })
    }
    if (pin && (!fs.existsSync(pinsPath) || fs.readFileSync(pinsPath, "utf8") !== json(manifest))) {
      fs.mkdirSync(path.dirname(pinsPath), { recursive: true })
      fs.writeFileSync(pinsPath, json(manifest))
    }
    return { dir: destination, manifest, files: Object.keys(files) }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
