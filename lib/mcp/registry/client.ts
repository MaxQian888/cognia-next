// Client for the official MCP Registry (registry.modelcontextprotocol.io).
//
// Why this shape:
//   - The registry serves `Access-Control-Allow-Origin: *`, so CORS is a
//     non-issue — but CORS is not what blocks the packaged desktop shell.
//     `connect-src` is, and `registry.modelcontextprotocol.io` is not on it,
//     so the call goes through `proxyFetch` (a passthrough off Tauri, which
//     keeps the browser shell and the static export working unchanged).
//   - Results are mapped onto `McpPreset`, the same type the curated catalog
//     uses, so the gallery's configure step / handlePick work unchanged.
//
// API: GET /v0.1/servers?search=&limit=&cursor= → { servers, metadata.nextCursor }
// Docs: https://github.com/modelcontextprotocol/registry

import { proxyFetch } from "@/lib/network/proxy-fetch"

import type { McpTransport } from "@cognia/agent-config-types"
import type { McpPreset, McpPresetField } from "@/lib/claude/mcp-presets"

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io"

/** A `{ value }` / `{ name, value }` argument as the registry models it. */
interface RegistryArgument {
  type?: string
  name?: string
  value?: string
}

interface RegistryEnvVar {
  name: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  default?: string
}

interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  transport?: { type?: string }
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: RegistryEnvVar[]
}

interface RegistryRemote {
  type?: string
  url?: string
}

interface RegistryServer {
  name: string
  title?: string
  description?: string
  version?: string
  repository?: { url?: string }
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
}

interface RegistryEntry {
  server: RegistryServer
}

export interface RegistrySearchResult {
  presets: McpPreset[]
  nextCursor: string | null
}

/**
 * Registry names are reverse-DNS namespaced ("io.github.foo/bar"). Cognia
 * server names are flat, so take the trailing segment and sanitise it into
 * something usable as an MCP server name.
 */
export function shortNameOf(registryName: string): string {
  const tail = registryName.split("/").pop() ?? registryName
  return tail.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60) || registryName
}

/** Flatten a registry argument list into argv tokens. */
function argTokens(args: RegistryArgument[] | undefined): string[] {
  const out: string[] = []
  for (const arg of args ?? []) {
    if (arg.type === "named" && arg.name) {
      out.push(arg.name)
      if (arg.value) out.push(arg.value)
      continue
    }
    if (arg.value) out.push(arg.value)
  }
  return out
}

/** Map the registry's env-var descriptors onto preset form fields. */
function envFields(pkg: RegistryPackage): McpPresetField[] {
  return (pkg.environmentVariables ?? []).map((env) => ({
    key: env.name,
    label: env.name,
    placement: "env" as const,
    secret: env.isSecret === true,
    description: env.description,
  }))
}

/**
 * Turn one registry entry into an installable preset. Returns null when the
 * entry can't be expressed as a Cognia server — better to hide it than to hand
 * the user a config that cannot start.
 *
 * Remotes win over packages: a hosted endpoint needs no local runtime.
 */
export function registryEntryToPreset(entry: RegistryEntry): McpPreset | null {
  const server = entry?.server
  if (!server?.name) return null

  const id = shortNameOf(server.name)
  const base = {
    id,
    name: server.title?.trim() || id,
    description: server.description?.trim() || server.name,
    icon: "🛰️",
    docsUrl: server.repository?.url,
    tags: ["registry"],
  }

  const remote = (server.remotes ?? []).find((r) => typeof r.url === "string" && r.url)
  if (remote?.url) {
    const transport: McpTransport = remote.type === "sse" ? "sse" : "http"
    return {
      ...base,
      transport,
      config: { url: remote.url },
      fields: [
        {
          key: "Authorization",
          label: "Authorization header",
          placement: "header",
          placeholder: "Bearer …",
          secret: true,
          description: "Optional. Leave empty for unauthenticated servers.",
        },
      ],
    }
  }

  const pkg = (server.packages ?? []).find(
    (p) => !p.transport?.type || p.transport.type === "stdio"
  )
  if (!pkg?.identifier) return null

  // Only npm and PyPI have a dependable zero-install runner (npx / uvx). OCI
  // and NuGet need a local daemon or SDK we can't assume, so we skip them
  // rather than emit a command that fails on first run.
  let command: string
  let packageToken: string
  if (pkg.registryType === "npm") {
    command = pkg.runtimeHint || "npx"
    packageToken = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier
  } else if (pkg.registryType === "pypi") {
    command = pkg.runtimeHint || "uvx"
    packageToken = pkg.identifier
  } else {
    return null
  }

  const args = [
    ...argTokens(pkg.runtimeArguments),
    packageToken,
    ...argTokens(pkg.packageArguments),
  ]
  const env: Record<string, string> = {}
  for (const variable of pkg.environmentVariables ?? []) {
    env[variable.name] = variable.default ?? ""
  }

  const config: Record<string, unknown> = { command, args }
  if (Object.keys(env).length > 0) config.env = env

  return { ...base, transport: "stdio", config, fields: envFields(pkg) }
}

/**
 * Search the official registry. `search` is a free-text query; omit it to
 * browse. Pass the previous result's `nextCursor` to page.
 */
export async function searchRegistry(opts: {
  search?: string
  cursor?: string | null
  limit?: number
  signal?: AbortSignal
}): Promise<RegistrySearchResult> {
  const params = new URLSearchParams()
  if (opts.search?.trim()) params.set("search", opts.search.trim())
  if (opts.cursor) params.set("cursor", opts.cursor)
  params.set("limit", String(opts.limit ?? 30))

  const res = await proxyFetch(`${REGISTRY_BASE}/v0.1/servers?${params.toString()}`, {
    signal: opts.signal,
    headers: { Accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(`MCP registry search failed: ${res.status}`)
  }

  const body = (await res.json()) as {
    servers?: RegistryEntry[]
    metadata?: { nextCursor?: string }
  }

  const presets: McpPreset[] = []
  // De-dupe on the FULL reverse-DNS name: the registry returns one row per
  // version, and we want only the first (latest). Keying this on the short id
  // instead would silently drop `com.a/github` in favour of `com.b/github`.
  const seenNames = new Set<string>()
  const usedIds = new Set<string>()

  for (const entry of body.servers ?? []) {
    const fullName = entry?.server?.name
    if (!fullName || seenNames.has(fullName)) continue
    seenNames.add(fullName)

    const preset = registryEntryToPreset(entry)
    if (!preset) continue

    // Two distinct servers can still shorten to the same id; suffix the later
    // one so React keys and the "already added" check stay unambiguous.
    let id = preset.id
    for (let n = 2; usedIds.has(id); n++) id = `${preset.id}-${n}`
    usedIds.add(id)

    presets.push(id === preset.id ? preset : { ...preset, id })
  }

  return { presets, nextCursor: body.metadata?.nextCursor ?? null }
}
