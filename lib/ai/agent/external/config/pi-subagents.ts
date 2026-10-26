/** Versioned Pi extension detection and task snapshots. No packages are installed here. */
import { contentDigest } from "@cognia/agent"
import type {
  ExternalAgentCogniaModelBinding,
  ExternalAgentConfig,
} from "@/types/agent/external-agent"
import { parseFrontmatter } from "@/lib/claude/subagent-importers/_parse-helpers"
import { parsePiSource } from "@/lib/pi-packages/identity"
import { extractPiPackages } from "@/lib/pi-packages/settings-io"

type PiConfig = Pick<ExternalAgentConfig, "protocol" | "process" | "metadata">
export interface PiSubagentSnapshot {
  family: "nico" | "gotgenes"
  version: string
  packageDir: string
  extensions: string[]
  agents: Record<string, { content: string; path: string; digest: string; model?: string }>
  defaultModel?: string
  modelOverrides?: Record<string, string>
}
export interface PiSubagentReadDeps {
  agentDir(): Promise<string | null>
  read(path: string): Promise<string | null>
  list(path: string, recursive?: boolean): Promise<string[]>
  directoryExists?(path: string): Promise<boolean>
}
const KEY = "cogniaPiSubagents"
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SUPPORTED: Record<string, { family: PiSubagentSnapshot["family"]; versions: string[] }> = {
  "pi-subagents": { family: "nico", versions: ["0.80.0"] },
  "@gotgenes/pi-subagents": { family: "gotgenes", versions: ["19.2.2"] },
}

/** Ephemeral host snapshot; always refreshed at task admission, never an installation grant. */
export function piSubagentSupport(config: PiConfig): PiSubagentSnapshot | undefined {
  if (config.protocol !== "pi-rpc") return undefined
  const snapshot = config.metadata?.[KEY] as PiSubagentSnapshot | undefined
  return snapshot &&
    Object.values(SUPPORTED).some(
      (entry) => entry.family === snapshot.family && entry.versions.includes(snapshot.version)
    )
    ? snapshot
    : undefined
}

function missing(error: unknown): boolean {
  return /ENOENT|not found|does not exist|no such file/i.test(String(error))
}
async function hostDeps(): Promise<PiSubagentReadDeps> {
  const { agentInvoke, agentReadTextFile, agentListFiles } = await import("../agent-transport")
  return {
    agentDir: async () =>
      (await agentInvoke<{ piAgentDir?: string }>("agent_vendor_roots", {})).piAgentDir ?? null,
    read: async (path) => {
      try {
        return await agentReadTextFile(path, [path.slice(0, path.lastIndexOf("/"))])
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
    directoryExists: async (path) => {
      try {
        await agentInvoke("fs_list_workspace_dir", {
          root: path,
          relPath: "",
          includeIgnored: true,
        })
        return true
      } catch (error) {
        if (missing(error)) return false
        throw error
      }
    },
    list: async (path, recursive) => {
      try {
        if (!recursive) return await agentListFiles(path, [path])
        const files: string[] = []
        let directories = 0
        const visit = async (directory: string, depth: number): Promise<void> => {
          if (depth > 8 || ++directories > 128) throw new Error("Pi agent directory limit exceeded")
          const entries = await agentInvoke<Array<{ absolute_path: string; is_dir: boolean }>>(
            "fs_list_workspace_dir",
            {
              root: path,
              relPath: directory.slice(path.length).replace(/^\//, ""),
              includeIgnored: true,
            }
          )
          for (const entry of entries) {
            if (!entry.absolute_path.startsWith(`${path}/`))
              throw new Error("Invalid Pi agent directory entry")
            if (entry.is_dir) await visit(entry.absolute_path, depth + 1)
            else files.push(entry.absolute_path)
          }
        }
        await visit(path, 0)
        return files
      } catch (error) {
        if (missing(error)) return []
        throw error
      }
    },
  }
}

/** Detect enabled npm packages already on this execution host, then snapshot custom definitions. */
export async function resolvePiSubagents<T extends PiConfig>(
  config: T,
  deps?: PiSubagentReadDeps
): Promise<T> {
  if (config.protocol !== "pi-rpc") return config
  const metadata = { ...config.metadata }
  delete metadata[KEY]
  const clean = { ...config, metadata }
  const io = deps ?? (await hostDeps())
  let root: string | null
  try {
    root = config.process?.env?.PI_CODING_AGENT_DIR ?? (await io.agentDir())
  } catch {
    return clean
  }
  if (!root) return clean
  const text = await io.read(`${root}/settings.json`)
  if (text === null) return clean
  const settings = JSON.parse(text) as Record<string, unknown>
  const candidates: PiSubagentSnapshot[] = []
  for (const entry of extractPiPackages(settings).packages) {
    if (typeof entry !== "string" && (entry.autoload === false || entry.extensions !== undefined))
      continue
    const parsed = parsePiSource(typeof entry === "string" ? entry : entry.source)
    const supported = parsed.name ? SUPPORTED[parsed.name] : undefined
    if (!supported || parsed.kind !== "npm") continue
    const packageDir = `${root}/npm/node_modules/${parsed.name}`
    const manifestText = await io.read(`${packageDir}/package.json`)
    if (manifestText === null) continue
    const manifest = JSON.parse(manifestText)
    if (manifest.name !== parsed.name || !supported.versions.includes(manifest.version)) continue
    const extensions: unknown = manifest.pi?.extensions
    if (
      !Array.isArray(extensions) ||
      !extensions.length ||
      !extensions.every(
        (path) =>
          typeof path === "string" && !path.startsWith("/") && !path.split(/[\\/]/).includes("..")
      )
    )
      continue
    const paths = extensions.map((path) => `${packageDir}/${path.replace(/^\.\//, "")}`)
    if ((await Promise.all(paths.map((path) => io.read(path)))).some((text) => text === null))
      continue
    candidates.push({
      family: supported.family,
      version: manifest.version,
      packageDir,
      extensions: paths,
      agents: {},
    })
  }
  if (candidates.length > 1)
    throw new Error(
      "Multiple Pi subagent packages are enabled; select one before configuring child models"
    )
  const snapshot = candidates[0]
  if (!snapshot) return clean
  let projectCwd = config.process?.cwd?.replaceAll("\\", "/").replace(/\/$/, "")
  if (snapshot.family === "nico") {
    while (projectCwd) {
      // Pi's home configuration is never an implicit project root.
      if (`${projectCwd}/.pi/agent` === root) {
        projectCwd = undefined
        break
      }
      const candidate = `${projectCwd}/.pi`
      const exists = io.directoryExists
        ? await io.directoryExists(candidate)
        : (await io.read(`${candidate}/settings.json`)) !== null ||
          (await io.list(`${candidate}/agents`, true)).length > 0
      if (exists) break
      const parent = projectCwd.slice(0, projectCwd.lastIndexOf("/"))
      projectCwd = parent === projectCwd ? undefined : parent || undefined
    }
  }
  const projectSettingsText = projectCwd ? await io.read(`${projectCwd}/.pi/settings.json`) : null
  const projectSettings = projectSettingsText === null ? {} : JSON.parse(projectSettingsText)
  snapshot.modelOverrides = {}
  for (const layer of snapshot.family === "nico" ? [settings, projectSettings] : []) {
    if (!layer.subagents || typeof layer.subagents !== "object") continue
    const native = layer.subagents as {
      defaultModel?: unknown
      agentOverrides?: Record<string, { model?: unknown }>
      agentScanDirs?: unknown[]
      agentOverridesByProvider?: unknown
      projectRootResolution?: string
    }
    if (
      native.agentScanDirs?.length ||
      native.agentOverridesByProvider !== undefined ||
      (native.projectRootResolution !== undefined && native.projectRootResolution !== "nearest")
    )
      throw new Error(
        "Managed Pi models require standard agent directories and provider-independent overrides"
      )
    if (native.defaultModel !== undefined) {
      if (typeof native.defaultModel !== "string" || !native.defaultModel.trim())
        throw new Error("Invalid Pi child default model")
      snapshot.defaultModel = native.defaultModel
    }
    for (const [name, override] of Object.entries(native.agentOverrides ?? {})) {
      if (override?.model === undefined) continue
      if (!SAFE_NAME.test(name) || typeof override.model !== "string" || !override.model.trim())
        throw new Error("Invalid Pi agent model override")
      snapshot.modelOverrides[name] = override.model
    }
  }
  const directories = [`${root}/agents`, ...(projectCwd ? [`${projectCwd}/.pi/agents`] : [])]
  for (const directory of directories) {
    for (const path of (await io.list(directory, snapshot.family === "nico")).sort()) {
      const filename = path.slice(path.lastIndexOf("/") + 1)
      if (
        !filename.endsWith(".md") ||
        (snapshot.family === "nico" && filename.endsWith(".chain.md"))
      )
        continue
      const content = await io.read(path)
      if (content === null) throw new Error("Pi subagent disappeared during detection")
      if (content.length > 65536) throw new Error("Pi subagent definition is too large")
      const { data } = parseFrontmatter(content)
      const name =
        snapshot.family === "nico" && typeof data.name === "string"
          ? data.name
          : filename.slice(0, -3)
      if (!SAFE_NAME.test(name)) throw new Error("Unsupported Pi subagent name")
      if (
        data.model !== undefined &&
        (typeof data.model !== "string" || !data.model.trim() || data.model !== data.model.trim())
      )
        throw new Error(`Invalid Pi subagent model: ${name}`)
      snapshot.agents[name] = {
        content,
        path,
        digest: contentDigest(content),
        ...(data.model !== undefined ? { model: data.model as string } : {}),
      }
      if (Object.keys(snapshot.agents).length > 64)
        throw new Error("Too many Pi subagent definitions")
    }
  }
  for (const [name, model] of Object.entries(snapshot.modelOverrides ?? {}))
    if (snapshot.agents[name]) snapshot.agents[name].model = model
  return { ...clean, metadata: { ...metadata, [KEY]: snapshot } }
}

/** Exact references only: invalid explicit choices must not become a fuzzy parent fallback. */
export function piModelBinding(
  model: string,
  primary: ExternalAgentCogniaModelBinding
): ExternalAgentCogniaModelBinding {
  if (model === "inherit") return { ...primary }
  const slash = model.indexOf("/")
  const provider = slash > 0 ? model.slice(0, slash) : primary.providerId
  const id = slash > 0 ? model.slice(slash + 1) : model
  if (!id || /[\s*:#\u0000-\u001f]/.test(id)) throw new Error("Invalid Pi subagent model reference")
  return { providerId: provider === "cognia" ? primary.providerId : provider, modelId: id }
}

export function piSubagentModelBindings(
  config: PiConfig,
  primary: ExternalAgentCogniaModelBinding
): Record<string, ExternalAgentCogniaModelBinding> {
  const snapshot = piSubagentSupport(config)
  return {
    ...(snapshot?.defaultModel
      ? { "pi.default": piModelBinding(snapshot.defaultModel, primary) }
      : {}),
    ...Object.fromEntries(
      Object.entries(snapshot?.modelOverrides ?? {}).map(([name, model]) => [
        `pi.agent.${name}`,
        piModelBinding(model, primary),
      ])
    ),
    ...Object.fromEntries(
      Object.entries(piSubagentSupport(config)?.agents ?? {})
        .filter(([, entry]) => entry.model !== undefined)
        .map(([name, entry]) => [`pi.agent.${name}`, piModelBinding(entry.model!, primary)])
    ),
  }
}
