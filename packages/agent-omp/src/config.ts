/** Pure path/config projections. Hosts own IO, YAML parsing, discovery and migration. */
export class OmpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OmpConfigError"
  }
}
export const OMP_CONFIG_REQUIREMENTS = Object.freeze({
  upstreamVersion: "18.6.1",
  minimumBunVersion: "1.3.14",
  executable: "omp",
  globalSettingsNames: Object.freeze(["config.yml", "config.yaml"]),
  projectSettingsNames: Object.freeze(["settings.json", "config.yml"]),
  mcpNames: Object.freeze(["mcp.json", ".mcp.json"]),
  profileEnvironmentKeys: Object.freeze(["OMP_PROFILE", "PI_PROFILE"]),
  configDirectoryEnvironmentKey: "PI_CONFIG_DIR",
  agentDirectoryEnvironmentKey: "PI_CODING_AGENT_DIR",
})
export function normalizeOmpProfile(profile?: string): string | undefined {
  const name = profile?.trim()
  if (!name || name === "default") return undefined
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ||
    name.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(name)
  ) {
    throw new OmpConfigError("Invalid OMP profile name")
  }
  return name
}
export interface OmpPathOptions {
  homeDir: string
  cwd: string
  profile?: string
  agentDir?: string
  env?: Readonly<Record<string, string | undefined>>
  /** Effective XDG category directories, resolved by the host after existence checks. */
  resolvedDataDir?: string
  resolvedStateDir?: string
}
function absolute(path: string): boolean {
  return /^(?:\/|[a-z]:[\\/])/i.test(path)
}
function join(base: string, ...parts: string[]): string {
  const separator = base.includes("\\") ? "\\" : "/"
  return [base.replace(/[\\/]+$/, ""), ...parts.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, ""))].join(
    separator
  )
}
/** No filesystem guesses: the host passes resolved XDG paths when upstream uses them. */
export function resolveOmpPaths(options: OmpPathOptions) {
  const { homeDir, cwd, env = {} } = options
  for (const path of [homeDir, cwd, options.resolvedDataDir, options.resolvedStateDir].filter(
    (p): p is string => p !== undefined
  )) {
    if (!absolute(path) || path.includes("\0"))
      throw new OmpConfigError("OMP paths must be absolute and contain no NUL")
  }
  const profile = normalizeOmpProfile(options.profile ?? env.OMP_PROFILE ?? env.PI_PROFILE)
  const configName = env.PI_CONFIG_DIR || ".omp"
  if (configName.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(configName))
    throw new OmpConfigError("Invalid OMP config directory")
  // Upstream PI_CONFIG_DIR is a home-relative directory name (path.join), not an agent override.
  const configRoot = join(homeDir, configName)
  const profileRoot = profile ? join(configRoot, "profiles", profile) : configRoot
  const override = options.agentDir ?? env.PI_CODING_AGENT_DIR
  if (override?.includes("\0")) throw new OmpConfigError("Invalid OMP agent directory")
  const agentDir = profile
    ? join(profileRoot, "agent")
    : override
      ? absolute(override)
        ? override
        : join(cwd, override)
      : join(profileRoot, "agent")
  const projectDir = join(cwd, ".omp")
  const dataDir = options.resolvedDataDir ?? agentDir
  return {
    profile,
    configRoot,
    profileRoot,
    agentDir,
    projectDir,
    settingsFiles: [join(agentDir, "config.yml"), join(agentDir, "config.yaml")],
    projectConfigFile: join(projectDir, "config.yml"),
    mcpFiles: [
      join(projectDir, "mcp.json"),
      join(projectDir, ".mcp.json"),
      join(agentDir, "mcp.json"),
      join(agentDir, ".mcp.json"),
    ],
    sessionDir: join(dataDir, "sessions"),
    blobDir: join(dataDir, "blobs"),
    commandsDir: join(agentDir, "commands"),
    agentsDir: join(agentDir, "agents"),
    memoriesDir: join(options.resolvedStateDir ?? agentDir, "memories"),
  }
}
/** Validates JSON-compatible host-parsed YAML and copies every field, including future keys. */
export function projectOmpConfig(value: unknown): { settings: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OmpConfigError("OMP config must be an object")
  const seen = new WeakSet<object>()
  const clone = (input: unknown, depth: number): unknown => {
    if (depth > 100) throw new OmpConfigError("OMP config nesting exceeds 100 levels")
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number" && Number.isFinite(input)) return input
    if (!input || typeof input !== "object" || seen.has(input))
      throw new OmpConfigError(
        "OMP config must contain finite JSON-compatible values without cycles"
      )
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      throw new OmpConfigError("OMP config must contain plain objects")
    seen.add(input)
    const result = Array.isArray(input)
      ? input.map((v) => clone(v, depth + 1))
      : Object.fromEntries(Object.entries(input).map(([k, v]) => [k, clone(v, depth + 1)]))
    seen.delete(input)
    return result
  }
  return { settings: clone(value, 0) as Record<string, unknown> }
}
