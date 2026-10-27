/** Verified Node-only bundles. This is a host module, never a renderer import. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { agentSearchDirs, defaultAgentPathRuntime, type AgentPathRuntime } from "./agent-path"
import embeddedPins from "../../../../sidecar/native-agents/pins.json"

const SPECS = {
  codebuff: ["codebuff.cjs", "--cognia-codebuff-bridge"],
  "crush-http": ["crush-http.cjs", "--cognia-crush-bridge"],
  "hermes-probe": ["hermes-probe.cjs", "--hermes-gateway-probe"],
  "hermes-acp": ["hermes-acp.cjs", "--cognia-hermes-acp"],
} as const
export type NativeAgentBridgeId = keyof typeof SPECS
export interface NativeAgentBridgeLaunch {
  command: string
  args: string[]
  sha256: string
}
export interface NativeAgentBridgePins {
  schemaVersion: number
  bridges: Record<NativeAgentBridgeId, { file: string; args: string[]; sha256: string }>
  dependencyFiles: Record<string, string>
  [key: string]: unknown
}
const digest = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const isId = (id: string): id is NativeAgentBridgeId => Object.hasOwn(SPECS, id)

/** Fixed read-only identity challenge; CLI --version is not interpreter proof. */
export const NATIVE_BRIDGE_NODE_IDENTITY_SCRIPT =
  'process.stdout.write(JSON.stringify({marker:"cognia-node-identity-v1",version:process.versions.node,release:process.release.name,execPath:require("node:fs").realpathSync(process.execPath),bun:Boolean(process.versions.bun),packaged:Boolean(process.pkg)}))'
interface NodeProbeOptions {
  encoding: "utf8"
  timeout: number
  maxBuffer: number
  windowsHide: boolean
  shell: false
  env: NodeJS.ProcessEnv
}
export type NativeBridgeInterpreterProbe = (
  command: string,
  args: readonly string[],
  options: NodeProbeOptions
) => { status: number | null; stdout: string | Buffer | null; error?: Error }
export interface NativeBridgeInterpreterOptions {
  execPath?: string
  versions?: Readonly<Record<string, string | undefined>>
  packaged?: boolean
  runtime?: AgentPathRuntime
  probe?: NativeBridgeInterpreterProbe
}
function packagedHost(): boolean {
  return Boolean((process as unknown as { pkg?: unknown }).pkg)
}
let hostInterpreter: { command: string; identity: string } | undefined
function interpreterFileIdentity(command: string): string {
  const stat = fs.statSync(command)
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}`
}
export function nativeBridgeInterpreterEnvironment(
  source: Readonly<Record<string, string | undefined>>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" }
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (source[name]) env[name] = source[name]
  return env
}

/** Only the operator's local runtime selects Node. No paired caller supplies a path. */
export function resolveNativeBridgeInterpreter(
  suppliedOptions?: NativeBridgeInterpreterOptions
): string {
  if (!suppliedOptions && hostInterpreter) {
    try {
      if (interpreterFileIdentity(hostInterpreter.command) === hostInterpreter.identity)
        return hostInterpreter.command
    } catch {
      /* A removed interpreter is an identity change too. */
    }
    throw new Error(
      "The verified Node.js interpreter changed or disappeared. Restart Cognia with plain Node.js 26+ available before launching native agent bridges."
    )
  }
  const options = suppliedOptions ?? {}
  const runtime = options.runtime ?? defaultAgentPathRuntime(),
    execPath = options.execPath ?? process.execPath,
    versions = options.versions ?? process.versions
  const packaged = options.packaged ?? packagedHost(),
    bun = Boolean(versions.bun)
  const env = nativeBridgeInterpreterEnvironment(runtime.env)
  const probe: NativeBridgeInterpreterProbe =
    options.probe ?? ((command, args, config) => spawnSync(command, [...args], config))
  const candidates: string[] = [],
    visited = new Set<string>()
  let self: string | undefined
  try {
    self = fs.realpathSync(execPath)
  } catch {
    /* Missing host executable cannot be an interpreter. */
  }
  if (!packaged && !bun && Number(versions.node?.split(".")[0]) >= 26) candidates.push(execPath)
  const executableName = runtime.platform === "win32" ? "node.exe" : "node"
  for (const directory of agentSearchDirs(runtime))
    candidates.push(path.join(directory, executableName))
  if (runtime.platform === "darwin")
    for (const directory of [
      "/opt/homebrew/opt/node@26/bin",
      "/usr/local/opt/node@26/bin",
      "/usr/bin",
    ])
      candidates.push(path.join(directory, executableName))
  else if (runtime.platform === "linux") candidates.push("/usr/bin/node", "/bin/node")
  else if (runtime.platform === "win32")
    for (const root of [runtime.env.ProgramFiles, runtime.env.ProgramW6432])
      if (root) candidates.push(path.join(root, "nodejs/node.exe"))
  let attempts = 0
  const inspect = (candidate: string, follow: boolean): string | undefined => {
    try {
      if (!path.isAbsolute(candidate)) return
      const canonical = fs.realpathSync(candidate)
      if (visited.has(canonical) || ((packaged || bun) && canonical === self)) return
      visited.add(canonical)
      if (!fs.statSync(canonical).isFile()) return
      fs.accessSync(canonical, fs.constants.X_OK)
      if (++attempts > 6) return
      const answer = probe(
        canonical,
        ["--input-type=commonjs", "--eval", NATIVE_BRIDGE_NODE_IDENTITY_SCRIPT],
        { encoding: "utf8", timeout: 1500, maxBuffer: 4096, shell: false, windowsHide: true, env }
      )
      if (
        answer.error ||
        answer.status !== 0 ||
        answer.stdout === null ||
        Buffer.byteLength(answer.stdout) > 4096
      )
        return
      const value: unknown = JSON.parse(String(answer.stdout))
      if (!value || typeof value !== "object") return
      const identity = value as Record<string, unknown>
      if (
        identity.marker !== "cognia-node-identity-v1" ||
        identity.release !== "node" ||
        identity.bun !== false ||
        identity.packaged !== false ||
        typeof identity.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(identity.version) ||
        Number(identity.version.split(".")[0]) < 26 ||
        typeof identity.execPath !== "string" ||
        !path.isAbsolute(identity.execPath)
      )
        return
      const actual = fs.realpathSync(identity.execPath)
      return actual === canonical ? canonical : follow ? inspect(actual, false) : undefined
    } catch {
      return undefined
    }
  }
  for (const candidate of candidates) {
    const found = inspect(candidate, true)
    if (found) {
      if (!suppliedOptions)
        hostInterpreter = { command: found, identity: interpreterFileIdentity(found) }
      return found
    }
  }
  throw new Error(
    "Install Node.js 26+ and expose its plain node executable on PATH to run Cognia's native agent bridges. Bun and the packaged Cognia executable are not Node interpreters."
  )
}

function filesUnder(root: string, prefix = ""): string[] {
  return fs
    .readdirSync(path.join(root, prefix))
    .sort()
    .flatMap((name) => {
      const relative = prefix + name
      const stat = fs.lstatSync(path.join(root, relative))
      if (stat.isSymbolicLink()) throw new Error(`native bridge symlink refused: ${relative}`)
      if (stat.isDirectory()) return filesUnder(root, relative + "/")
      if (!stat.isFile()) throw new Error(`native bridge non-file refused: ${relative}`)
      return [relative]
    })
}

/** Separate registry enables isolated behavioral tests; production owns one
 * instance with an owned layout root and verified plain Node interpreter.
 */
export class NativeAgentBridgeRegistry {
  private readonly registered = new Map<NativeAgentBridgeId, NativeAgentBridgeLaunch>()
  private readonly interpreterIdentity: string
  constructor(
    private readonly root: string,
    private readonly pins: NativeAgentBridgePins,
    private readonly node: string
  ) {
    this.interpreterIdentity = interpreterFileIdentity(fs.realpathSync(node))
  }

  private verifyInterpreter(): void {
    try {
      if (interpreterFileIdentity(fs.realpathSync(this.node)) === this.interpreterIdentity) return
    } catch {
      /* A removed interpreter revokes the registered invocation. */
    }
    this.registered.clear()
    throw new Error(
      "The verified native bridge interpreter changed; restart Cognia with plain Node.js 26+ available"
    )
  }

  private verify(): void {
    if (!fs.lstatSync(this.root).isDirectory())
      throw new Error("native bridge bundle directory missing or redirected")
    if (
      this.pins.schemaVersion !== 1 ||
      Object.keys(this.pins.bridges).sort().join() !== Object.keys(SPECS).sort().join()
    )
      throw new Error("native bridge embedded pins invalid")
    const expected: Record<string, string> = { ...this.pins.dependencyFiles }
    for (const id of Object.keys(SPECS) as NativeAgentBridgeId[]) {
      const pin = this.pins.bridges[id]
      if (pin.file !== SPECS[id][0] || pin.args.length !== 1 || pin.args[0] !== SPECS[id][1])
        throw new Error(`native bridge fixed invocation invalid: ${id}`)
      expected[pin.file] = pin.sha256
    }
    for (const [file, sha] of Object.entries(expected)) {
      if (
        !/^[a-f0-9]{64}$/.test(sha) ||
        file.includes("\\") ||
        file.split("/").some((part) => !part || part === "." || part === "..") ||
        path.isAbsolute(file)
      )
        throw new Error(`native bridge pin path or digest invalid: ${file}`)
    }
    const files = filesUnder(this.root).sort()
    if (
      files.join("\n") !==
      [...Object.keys(expected), "integrity.json", "pins.json"].sort().join("\n")
    )
      throw new Error("native bridge file inventory mismatch")
    for (const metadata of ["integrity.json", "pins.json"])
      if (
        JSON.stringify(JSON.parse(fs.readFileSync(path.join(this.root, metadata), "utf8"))) !==
        JSON.stringify(this.pins)
      )
        throw new Error(`native bridge metadata differs from embedded pins: ${metadata}`)
    for (const [file, sha] of Object.entries(expected))
      if (digest(path.join(this.root, file)) !== sha)
        throw new Error(`native bridge integrity mismatch: ${file}`)
  }

  resolve(id: string): NativeAgentBridgeLaunch {
    if (!isId(id)) throw new Error(`unsupported bundled native bridge: ${id}`)
    if (id === "codebuff" && process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Codebuff requires Cognia's mandatory macOS/Linux network-off sandbox")
    this.verifyInterpreter()
    this.registered.delete(id)
    try {
      this.verify()
    } catch (error) {
      throw new Error(
        `Bundled ${id} bridge unavailable; rebuild/reinstall Cognia's native agent assets: ${String(error)}`
      )
    }
    const pin = this.pins.bridges[id]
    const launch = {
      command: fs.realpathSync(this.node),
      args: [path.join(fs.realpathSync(this.root), pin.file), ...pin.args],
      sha256: pin.sha256,
    }
    this.registered.set(id, launch)
    return { ...launch, args: [...launch.args] }
  }

  permits(command: string, args: readonly string[]): boolean {
    for (const [id, launch] of this.registered) {
      if (args.length !== launch.args.length || !args.every((arg, i) => arg === launch.args[i]))
        continue
      let canonical: string
      try {
        canonical = fs.realpathSync(command)
      } catch {
        return false
      }
      if (
        !path.isAbsolute(command) ||
        canonical !== launch.command ||
        canonical !== fs.realpathSync(this.node)
      )
        return false
      try {
        this.verifyInterpreter()
        this.verify()
      } catch (error) {
        this.registered.delete(id)
        throw error
      }
      return true
    }
    return false
  }

  registeredId(command: string, args: readonly string[]): NativeAgentBridgeId | undefined {
    if (!this.permits(command, args)) return undefined
    return [...this.registered].find(
      ([, launch]) =>
        args.length === launch.args.length && args.every((arg, i) => arg === launch.args[i])
    )?.[0]
  }

  bundleRoot(command: string, args: readonly string[]): string | undefined {
    return this.permits(command, args) ? fs.realpathSync(this.root) : undefined
  }
}

export function resolveNativeBridgeBundleRoot(
  options: { execPath?: string; moduleUrl?: string; packaged?: boolean; bun?: boolean } = {}
): string {
  if ((options.packaged ?? packagedHost()) || (options.bun ?? Boolean(process.versions.bun))) {
    const directory = path.join(path.dirname(options.execPath ?? process.execPath), "sidecar")
    if (!fs.existsSync(directory))
      throw new Error(
        "Bundled native bridges missing beside Cognia's release executable; reinstall its complete sidecar layout"
      )
    return path.join(directory, "native-agents")
  }
  let dir = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url))
  for (let depth = 0; depth < 10; depth++) {
    // Stop at the first host layout. Missing bridge assets must never redirect
    // a packaged executable into an unrelated ancestor's sidecar directory.
    if (fs.existsSync(path.join(dir, "sidecar"))) return path.join(dir, "sidecar/native-agents")
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    "Bundled native bridges missing; rebuild/reinstall Cognia with its sidecar assets"
  )
}
let registry: NativeAgentBridgeRegistry | undefined
function hostRegistry(): NativeAgentBridgeRegistry {
  return (registry ??= new NativeAgentBridgeRegistry(
    resolveNativeBridgeBundleRoot(),
    embeddedPins as NativeAgentBridgePins,
    resolveNativeBridgeInterpreter()
  ))
}
export function resolveBundledAgentBridge(id: string): NativeAgentBridgeLaunch {
  return hostRegistry().resolve(id)
}
export function isRegisteredNativeBridgeInvocation(
  command: string,
  args: readonly string[]
): boolean {
  return registry?.permits(command, args) ?? false
}
export function registeredNativeBridgeId(
  command: string,
  args: readonly string[]
): NativeAgentBridgeId | undefined {
  return registry?.registeredId(command, args)
}
export function registeredNativeBridgeRoot(
  command: string,
  args: readonly string[]
): string | undefined {
  return registry?.bundleRoot(command, args)
}
/** Read-only helper state is selected by an opaque Hermes key, not a path. */
export function hermesProbeOwnedStateRoot(
  key: string | undefined,
  dataDir: string | undefined
): string {
  if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key) || !dataDir || !path.isAbsolute(dataDir))
    throw new Error("Hermes probe requires an owned Hermes state key and a host data directory")
  let current = fs.realpathSync(dataDir)
  for (const segment of ["cognia", "external-agents", key]) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Hermes probe state directory is missing or redirected")
  }
  const home = fs.lstatSync(path.join(current, "hermes"))
  if (!home.isDirectory() || home.isSymbolicLink())
    throw new Error("Hermes probe home is missing or redirected")
  return current
}
export function registeredHermesProbeStateRoot(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> | undefined,
  dataDir: string | undefined
): string | undefined {
  const id = registeredNativeBridgeId(command, args)
  if (id !== "hermes-probe" && id !== "hermes-acp") return undefined
  return hermesProbeOwnedStateRoot(env?.COGNIA_AGENT_STATE_KEY, dataDir)
}
export function validateNativeBridgeSandbox(
  id: NativeAgentBridgeId | undefined,
  network: string | undefined,
  platform: string = process.platform
): void {
  if (id !== "codebuff") return
  if ((platform !== "darwin" && platform !== "linux") || network !== "off")
    throw new Error(
      "Codebuff requires Cognia's mandatory macOS/Linux sandbox with sandboxPolicy.network:'off'"
    )
}
