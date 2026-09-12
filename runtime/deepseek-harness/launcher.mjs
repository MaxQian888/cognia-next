/** Cognia's verified entry into the official DSH product launcher. */
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const DSH_VERSION = "0.1.5-rc.1"
export const PROFILE_BY_COMPOSITION = Object.freeze({
  "host.sdk-readonly.yml": "cognia-sdk-readonly",
  "host.sdk-workspace.yml": "cognia-sdk-workspace",
  "host.acp.yml": "cognia-acp",
})

function inside(child, parent) {
  const path = relative(parent, child)
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path))
  )
}

// Resolve existing ancestors too: a not-yet-created child of a symlink must
// never pass containment merely because realpath(child) returns ENOENT.
function canonical(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    const parent = dirname(resolve(path))
    if (parent === resolve(path)) throw error
    return join(canonical(parent), basename(path))
  }
}

export function managedProfileManifest(profile) {
  return {
    name: profile,
    private: true,
    type: "module",
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-sdk-minimal"], patchReload: "startup" } },
  }
}

/** Validate owned files before the product CLI can evaluate any patch or .env. */
export function prepareLaunch(argv, env) {
  if (argv.length !== 3 || !isAbsolute(argv[2] ?? "")) {
    throw new Error("Usage: node launcher.mjs <absolute-path-to-host-composition.yml>")
  }
  if (!env.COGNIA_DSH_RUNTIME_HOME || !env.DSH_HOME) {
    throw new Error("COGNIA_DSH_RUNTIME_HOME and DSH_HOME must be set by Cognia's runtime manager")
  }
  const runtimeHome = realpathSync(env.COGNIA_DSH_RUNTIME_HOME)
  const home = canonical(env.DSH_HOME)
  if (!inside(home, runtimeHome) || home === runtimeHome) {
    throw new Error("DSH_HOME must be an isolated directory inside the Cognia runtime home")
  }
  const composition = realpathSync(argv[2])
  const profile = PROFILE_BY_COMPOSITION[basename(composition)]
  if (!profile || !inside(composition, runtimeHome)) {
    throw new Error("Composition must be a managed host profile inside the Cognia runtime home")
  }
  const profileDir = canonical(join(home, "profiles", profile))
  if (!inside(profileDir, home)) throw new Error("Managed profile escapes DSH_HOME")
  for (const path of [
    join(home, "cordis.patch.yml"),
    join(profileDir, "cordis.patch.yml"),
    join(home, ".env"),
  ]) {
    if (existsSync(path)) throw new Error(`Unmanaged DSH configuration: ${path}`)
  }
  const manifest = managedProfileManifest(profile)
  const manifestPath = join(profileDir, "package.json")
  if (!existsSync(manifestPath)) {
    mkdirSync(profileDir, { recursive: true })
    // Multiple agents may start this profile at once. Publish a complete file
    // atomically without overwriting an existing or concurrently created one.
    const temporary = join(profileDir, `.manifest-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" })
      try {
        linkSync(temporary, manifestPath)
      } catch (error) {
        if (error.code !== "EEXIST") throw error
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
  if (
    !inside(realpathSync(manifestPath), home) ||
    JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))) !== JSON.stringify(manifest)
  ) {
    throw new Error(
      `Managed DSH profile manifest differs from the approved composition: ${manifestPath}`
    )
  }
  const workspace = env.COGNIA_DSH_WORKSPACE ?? process.cwd()
  if (!isAbsolute(workspace)) throw new Error("COGNIA_DSH_WORKSPACE must be absolute")
  const sessionRoot = canonical(env.COGNIA_DSH_SESSION_ROOT ?? join(runtimeHome, "sessions"))
  if (!inside(sessionRoot, runtimeHome))
    throw new Error("Session persistence must remain inside the runtime home")
  return { home, profile, composition, workspace, sessionRoot }
}

export function resolveProductLauncher(require = createRequire(import.meta.url)) {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json")
  for (const name of [
    "dsh",
    "dsh-sdk-minimal",
    "dsh-sdk-protocol",
    "dsh-sdk-jsonrpc-server",
    "dsh-acp",
    "dsh-app-boot",
    "dsh-sdk-app",
    "dsh-acp-app",
    "dsh-session",
    "dsh-agent",
    "dsh-fs-sandbox",
    "dsh-tool-fs",
    "dsh-user-approval",
    "dsh-attachment-local",
    "dsh-mcp-client",
    "dsh-llm-pi-ai",
  ]) {
    const pkg = JSON.parse(
      readFileSync(require.resolve(`@deepseek-ai/${name}/package.json`), "utf8")
    )
    if (pkg.version !== DSH_VERSION)
      throw new Error(
        `Unsupported ${pkg.name} version ${pkg.version}; reinstall the managed ${DSH_VERSION} runtime`
      )
  }
  return join(dirname(manifestPath), "lib", "bin.js")
}

function parseJson(raw, field) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${field} must contain valid JSON`)
  }
}
function httpUrl(raw, field) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${field} must use an absolute HTTP(S) URL`)
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field} must use HTTP(S)`)
  return url
}

/** Same ACP-shaped descriptors on both transports; SDK mounts at process startup. */
export function resolveMcpConfigs(raw, workspace) {
  const servers = raw === undefined ? [] : parseJson(raw, "COGNIA_DSH_MCP_SERVERS")
  if (!Array.isArray(servers)) throw new Error("COGNIA_DSH_MCP_SERVERS must be an array")
  const seen = new Set()
  const entries = (values, header = false) => {
    if (!Array.isArray(values)) throw new Error("MCP environment/headers must be name/value arrays")
    const result = Object.create(null)
    const names = new Set()
    for (const entry of values) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        typeof entry.value !== "string" ||
        !entry.name ||
        /[=\0]/.test(entry.name) ||
        entry.value.includes("\0")
      )
        throw new Error("Invalid MCP environment/header entry")
      const identity = header ? entry.name.toLowerCase() : entry.name
      if (names.has(identity)) throw new Error("Duplicate MCP environment/header entry")
      names.add(identity)
      if (header) {
        try {
          new Headers([[entry.name, entry.value]])
        } catch {
          throw new Error("Invalid MCP header entry")
        }
      }
      result[entry.name] = entry.value
    }
    return result
  }
  return servers.map((server) => {
    if (
      !server ||
      typeof server.name !== "string" ||
      !server.name.trim() ||
      /[\u0000-\u001f\u007f]/.test(server.name)
    )
      throw new Error("Invalid MCP server name")
    const serverName = /^[A-Za-z0-9_-]{1,32}$/.test(server.name)
      ? server.name
      : `${
          server.name
            .normalize("NFKD")
            .replace(/[^A-Za-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 20) || "server"
        }_${createHash("sha256").update(server.name).digest("hex").slice(0, 8)}`.slice(0, 32)
    if (seen.has(serverName)) throw new Error("Duplicate MCP server namespace")
    seen.add(serverName)
    const shared = { serverName, failOnStartupError: true }
    if (!("type" in server)) {
      if (
        typeof server.command !== "string" ||
        !isAbsolute(server.command) ||
        !Array.isArray(server.args) ||
        server.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      )
        throw new Error("MCP stdio requires an absolute command and string args")
      return {
        ...shared,
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: entries(server.env ?? []),
        cwd: workspace,
      }
    }
    if (server.type !== "http") throw new Error("MCP transport must be stdio or HTTP")
    const url = httpUrl(server.url, "MCP endpoint")
    return {
      ...shared,
      transport: "streamable-http",
      url: url.href,
      headers: entries(server.headers ?? [], true),
    }
  })
}

export function resolveCogniaServices(env, workspace, profile) {
  const mcp = resolveMcpConfigs(env.COGNIA_DSH_MCP_SERVERS, workspace)
  if (profile === "cognia-acp" && mcp.length)
    throw new Error("ACP MCP servers must be scoped through session/new")
  for (const key of ["COGNIA_DSH_ALLOWED_TOOLS", "COGNIA_DSH_ADDITIONAL_DIRECTORIES"]) {
    if (env[key] === undefined) continue
    const values = parseJson(env[key], key)
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string" || !value || value.includes("\0"))
    )
      throw new Error(`${key} must be a string array`)
    if (key === "COGNIA_DSH_ADDITIONAL_DIRECTORIES" && values.some((value) => !isAbsolute(value)))
      throw new Error("Additional workspace directories must be absolute")
  }
  const provider = env.COGNIA_DSH_PROVIDER ?? "deepseek-official"
  if (!["deepseek-official", "cognia"].includes(provider))
    throw new Error("Unsupported managed model provider")
  let gateway
  if (provider === "cognia") {
    if (!env.COGNIA_DSH_GATEWAY_CONFIG || !env.COGNIA_DSH_GATEWAY_TOKEN)
      throw new Error("Cognia provider requires a managed gateway lease")
    gateway = parseJson(env.COGNIA_DSH_GATEWAY_CONFIG, "COGNIA_DSH_GATEWAY_CONFIG")
    const route = gateway?.providers?.cognia
    if (
      Object.keys(gateway?.providers ?? {}).length !== 1 ||
      route?.api !== "openai-completions" ||
      route.apiKeyEnv !== "COGNIA_DSH_GATEWAY_TOKEN" ||
      !Array.isArray(route.models) ||
      !route.models.some((model) => model.id === env.COGNIA_DSH_MODEL)
    )
      throw new Error("Cognia gateway route must name the selected model and managed credential")
    const endpoint = httpUrl(route.baseURL, "Cognia gateway endpoint")
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error("Invalid Cognia gateway endpoint")
  } else if (env.COGNIA_DSH_GATEWAY_CONFIG || env.COGNIA_DSH_GATEWAY_TOKEN)
    throw new Error("Cognia gateway lease requires the Cognia provider")
  return { mcp, gateway }
}

// This same digest-verified artifact is a Cordis plugin. Transports explicitly
// wait for its readiness service, so no prompt can race MCP discovery or route
// registration. Importing the plugin never executes the CLI entry below.
export const name = "cognia-services"
export const inject = ["tools", "llm"]
export async function apply(ctx) {
  const services = resolveCogniaServices(
    process.env,
    process.env.COGNIA_DSH_WORKSPACE,
    process.env.COGNIA_DSH_PROFILE
  )
  if (services.gateway) {
    const adapter = await import("@deepseek-ai/dsh-llm-pi-ai")
    await ctx.plugin(adapter, adapter.Config(services.gateway))
  }
  if (services.mcp.length) {
    const bridge = await import("@deepseek-ai/dsh-mcp-client")
    for (const config of services.mcp) await ctx.plugin(bridge, bridge.Config(config))
  }
  // allowedTools is preapproval, not a visibility mask. Broker authorization
  // owns those grants and extra roots; native tools keep the profile sandbox.
  ctx.provide("cogniaServicesReady", { ready: true })
}

export async function main() {
  const launch = prepareLaunch(process.argv, process.env)
  const bin = resolveProductLauncher()
  resolveCogniaServices(process.env, launch.workspace, launch.profile)
  process.env.COGNIA_DSH_PROFILE = launch.profile
  process.env.DSH_HOME = launch.home
  process.env.COGNIA_DSH_WORKSPACE = launch.workspace
  process.env.COGNIA_DSH_SESSION_ROOT = launch.sessionRoot
  process.env.DSH_TELEMETRY_DISABLED = "1"
  // The public CLI reads cwd/.env. Boot from the isolated home so workspace
  // credentials cannot bypass Cognia's scrubbed child environment. Both SDK
  // initialize and ACP session/new carry the actual workspace explicitly.
  process.chdir(launch.home)
  process.argv = [process.execPath, bin, "--profile", launch.profile, "--patch", launch.composition]
  const { runCli } = await import(pathToFileURL(bin).href)
  await runCli()
}

if (process.argv[1] && canonical(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`[cognia-dsh] ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
