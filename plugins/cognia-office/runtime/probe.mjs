/** Explicit installation discovery only: importing this module never loads Office code. */
import { constants } from "node:fs"
import { access, readFile, realpath, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const API_PACKAGE = "@deepseek-ai/libreoffice-kit"
const API_VERSION = "0.1.5"
const PROBE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

class ProbeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
function unavailable(message) {
  throw new ProbeError("unavailable", message)
}
function inside(root, path) {
  const child = relative(root, path)
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
}
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"))
}
function validateRequest(request) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    request.schemaVersion !== 1 ||
    request.operation !== "probe" ||
    Object.keys(request).some((key) => !["schemaVersion", "operation"].includes(key))
  ) {
    throw new ProbeError(
      "invalid-arguments",
      "Expected {schemaVersion:1,operation:'probe'} without document or path arguments"
    )
  }
}
function validateNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new ProbeError(
      "unsupported-runtime",
      "Office runtime discovery requires Node.js 22.19.0 or newer"
    )
  }
}
async function installedPackage(require, modulesRoot, name, expectedVersion) {
  const manifestPath = await realpath(require.resolve(`${name}/package.json`))
  if (!inside(modulesRoot, manifestPath))
    unavailable(`Package is not installed in this plugin runtime: ${name}`)
  const root = dirname(manifestPath)
  const manifest = await json(manifestPath)
  if (manifest.name !== name || manifest.version !== expectedVersion)
    unavailable(`Installed package identity mismatch: ${name}`)
  return { root, manifest }
}
async function installedAsset(root, value, kind, executable = false) {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value))
    unavailable("Invalid engine asset path")
  const lexical = resolve(root, value)
  if (!inside(root, lexical)) unavailable("Engine asset escapes its package")
  const path = await realpath(lexical)
  if (!inside(root, path)) unavailable("Engine asset link escapes its package")
  const info = await stat(path)
  if (kind === "directory" ? !info.isDirectory() : !info.isFile())
    unavailable(`Engine asset is not a ${kind}`)
  if (executable && process.platform !== "win32") await access(path, constants.X_OK)
  return path
}

/** root is a test/host embedding seam, never accepted from the stdin request. */
export async function probe(
  request,
  { root = PROBE_DIRECTORY, nodeVersion = process.versions.node } = {}
) {
  validateRequest(request)
  validateNode(nodeVersion)
  const runtimeRoot = await realpath(root)
  const modulesRoot = await realpath(resolve(runtimeRoot, "node_modules"))
  if (!inside(runtimeRoot, modulesRoot))
    unavailable("Runtime node_modules escapes its installation")
  const require = createRequire(pathToFileURL(resolve(runtimeRoot, "package.json")))
  const api = await installedPackage(require, modulesRoot, API_PACKAGE, API_VERSION)
  const entry = await realpath(require.resolve(API_PACKAGE))
  if (!inside(api.root, entry)) unavailable("Node API entry escapes its installed package")
  // This is the only Office import, after an explicit request and local package validation.
  const kit = await import(pathToFileURL(entry).href)
  if (kit.ENGINE_VERSION !== API_VERSION || typeof kit.discoverRuntime !== "function")
    unavailable("Installed Office API is incompatible")
  const discovered = await kit.discoverRuntime()
  if (discovered.version !== API_VERSION || !["native", "wasm"].includes(discovered.backend))
    unavailable("Installed Office runtime metadata is incompatible")
  if (discovered.backend === "wasm" && process.platform !== "linux")
    unavailable("WASM is supported only in the Linux Node host")
  const target = discovered.backend === "wasm" ? "wasm" : `${process.platform}-${process.arch}`
  const engineName = `${API_PACKAGE}-${target}`
  if (
    api.manifest.optionalDependencies?.[engineName] !== API_VERSION ||
    kit.ENGINE_VERSIONS?.[target] !== API_VERSION
  )
    unavailable("The selected engine is not pinned by this runtime bundle")
  const engine = await installedPackage(
    createRequire(pathToFileURL(entry)),
    modulesRoot,
    engineName,
    API_VERSION
  )
  const prebuilds = await json(resolve(engine.root, "prebuilds.json"))
  if (
    prebuilds.schemaVersion !== 1 ||
    prebuilds.version !== API_VERSION ||
    prebuilds.platform !== target ||
    prebuilds.status !== "built" ||
    prebuilds.engine?.kind !== discovered.backend
  )
    unavailable("Installed engine manifest is incompatible or incomplete")
  const paths = {}
  if (discovered.backend === "native") {
    paths.executable = await installedAsset(engine.root, prebuilds.engine.executable, "file", true)
    paths.programDirectory = await installedAsset(
      engine.root,
      prebuilds.engine.programDirectory,
      "directory"
    )
  } else {
    for (const name of ["loader", "wasm", "data", "metadata"])
      paths[name] = await installedAsset(engine.root, prebuilds.engine[name], "file")
    if (
      typeof prebuilds.engine.programDirectory !== "string" ||
      !prebuilds.engine.programDirectory.startsWith("/")
    )
      unavailable("Invalid WASM virtual program directory")
    paths.programDirectory = prebuilds.engine.programDirectory
  }
  const nodeApiPath = await realpath(discovered.nodeApiPath)
  const cliPath = await realpath(discovered.cliPath)
  if (nodeApiPath !== entry || !inside(api.root, cliPath) || !(await stat(cliPath)).isFile())
    unavailable("Discovered runtime entry paths escape the verified package")
  return {
    apiVersion: API_VERSION,
    engineVersion: engine.manifest.version,
    backend: discovered.backend,
    platform: process.platform,
    arch: process.arch,
    nodeVersion,
    packageRoot: api.root,
    engineRoot: engine.root,
    nodeApiPath,
    cliPath,
    enginePaths: paths,
    documentsSupported: false,
  }
}

export function failure(error) {
  const code =
    error?.code === "invalid-arguments" || error?.code === "unsupported-runtime"
      ? error.code
      : "unavailable"
  return { ok: false, error: { code, message: String(error?.message ?? error).slice(0, 4096) } }
}
async function main() {
  try {
    const chunks = []
    let length = 0
    for await (const chunk of process.stdin) {
      length += chunk.length
      if (length > 4096) throw new ProbeError("invalid-arguments", "Probe request exceeds 4 KiB")
      chunks.push(Buffer.from(chunk))
    }
    let request
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      throw new ProbeError("invalid-arguments", "Probe request must be JSON")
    }
    process.stdout.write(`${JSON.stringify({ ok: true, result: await probe(request) })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(error))}\n`)
    process.exitCode = 1
  }
}
if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
)
  await main()
