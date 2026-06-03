/**
 * The single LSP configuration resolver.
 *
 * Layers four sources by `id`, later layers overriding earlier ones, into one
 * {@link ResolvedLspServer}[] that drives BOTH the agent runtime LSP (serialised
 * into `sendOptions.lsp` by `lib/claude/build-options.ts`) and the editor LSP
 * registry (`lib/plugin/lsp/lsp-user-servers.ts`).
 *
 * Layer order (lowest → highest priority):
 *   1. builtin defaults (`lib/lsp/builtin-defaults.ts`)
 *   2. plugin-contributed servers (editor passes these; agent omits)
 *   3. user global servers (`AppSettings.lsp.servers`)
 *   4. project-local `.cognia/lsp.json`
 *
 * Same-id entries in a higher layer merge onto the lower one field-by-field;
 * the object-valued fields `settings`, `env`, and `initializationOptions` are
 * DEEP-merged so a project file can tweak a single `rust-analyzer.cargo`
 * sub-key without clobbering the rest. An entry with `enabled: false` in any
 * layer removes that server from the result (including a builtin a user wants
 * gone).
 *
 * The core is pure and dependency-free: the project-file read is injected via
 * `readProjectFile` so it can be unit-tested without a filesystem. The Tauri
 * implementation lives in `lib/lsp/project-file-reader.ts`.
 */

import { BUILTIN_LSP_SERVERS } from "./builtin-defaults"
import type {
  LspProjectFile,
  LspServerConfig,
  LspServerSource,
  ResolvedLspServer,
} from "@/types/lsp/config"

export interface ResolveLspServersInput {
  /** Active project root dir. When set, `.cognia/lsp.json` is read from it. */
  rootDir?: string | null
  /** User global servers — `AppSettings.lsp.servers`. */
  userServers?: readonly LspServerConfig[]
  /** Plugin-contributed servers. The editor passes these; the agent omits them. */
  pluginServers?: readonly LspServerConfig[]
  /**
   * Reads and parses a project's `.cognia/lsp.json`. Returns `null` when the
   * file is absent or unreadable (the project layer is then empty). Injected
   * for testability.
   */
  readProjectFile?: (rootDir: string) => Promise<LspProjectFile | null>
  /** Include builtin defaults as the base layer. Default `true`. */
  includeBuiltins?: boolean
}

/** True for a plain `{}` object (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Recursively merge plain objects: `override` wins on scalars and arrays,
 * nested plain objects merge key-by-key. Used for `settings` / `env` /
 * `initializationOptions`.
 */
function deepMergeObjects(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base) return override ? { ...override } : undefined
  if (!override) return { ...base }
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key]
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMergeObjects(prev, value)
    } else {
      out[key] = value
    }
  }
  return out
}

const OBJECT_FIELDS = ["settings", "env", "initializationOptions"] as const

/**
 * Merge a higher-layer `next` config onto a lower-layer `prev` resolved
 * entry. Scalar/array fields are replaced when `next` defines them; the three
 * object fields are deep-merged.
 */
function mergeConfig(prev: ResolvedLspServer, next: LspServerConfig): ResolvedLspServer {
  const merged: Record<string, unknown> = { ...prev }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue
    if ((OBJECT_FIELDS as readonly string[]).includes(key)) continue
    merged[key] = value
  }
  for (const field of OBJECT_FIELDS) {
    const combined = deepMergeObjects(prev[field], next[field])
    if (combined === undefined) delete merged[field]
    else merged[field] = combined
  }
  return merged as unknown as ResolvedLspServer
}

/**
 * Resolve the layered LSP server list. Pure aside from the injected
 * `readProjectFile`. Result order follows first-seen id order (a builtin
 * keeps its slot even when a later layer overrides it).
 */
export async function resolveLspServers(
  input: ResolveLspServersInput
): Promise<ResolvedLspServer[]> {
  const includeBuiltins = input.includeBuiltins ?? true

  let projectServers: readonly LspServerConfig[] = []
  if (input.rootDir && input.readProjectFile) {
    try {
      const file = await input.readProjectFile(input.rootDir)
      if (file?.servers && Array.isArray(file.servers)) projectServers = file.servers
    } catch {
      // Unreadable / malformed project file → empty project layer, silently.
      projectServers = []
    }
  }

  const layers: Array<{ source: LspServerSource; servers: readonly LspServerConfig[] }> = [
    { source: "builtin", servers: includeBuiltins ? BUILTIN_LSP_SERVERS : [] },
    { source: "plugin", servers: input.pluginServers ?? [] },
    { source: "user", servers: input.userServers ?? [] },
    { source: "project", servers: projectServers },
  ]

  const byId = new Map<string, ResolvedLspServer>()
  for (const layer of layers) {
    for (const cfg of layer.servers) {
      if (!cfg || !cfg.id) continue
      const existing = byId.get(cfg.id)
      if (existing) {
        const merged = mergeConfig(existing, cfg)
        merged.overriddenBy = existing.source
        merged.source = layer.source
        byId.set(cfg.id, merged)
      } else {
        byId.set(cfg.id, { ...cfg, source: layer.source })
      }
    }
  }

  // Drop disabled entries last so a higher layer can re-enable a lower one.
  return Array.from(byId.values()).filter((s) => s.enabled !== false)
}
