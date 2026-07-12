/**
 * Web Clone — built-in plugin.
 *
 * Adds a user-triggered `/web-clone` slash command that snapshots a live web
 * page (HTML + all CSS/JS/image/font assets) into a self-contained file or a
 * directory bundle, with optional component extraction + framework codegen.
 *
 * This is the on-demand, user-facing entry point to the same vendored engine
 * that backs (a) the sidecar `web_clone` agent tool and (b) the `io.webClone`
 * workflow node. All three funnel through the deterministic
 * `web_clone_snapshot` Tauri command (`src-tauri/src/webclone.rs`), so the
 * engine — and its SSRF gate — is exercised identically everywhere. Desktop
 * only: the engine is a Node process reached via Tauri.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { isTauri } from "@/lib/tauri"
import { useGitStore } from "@/stores/git/git-store"

const CODEGEN_FRAMEWORKS = ["vue", "react", "angular", "svelte", "jquery"] as const
type CodegenFramework = (typeof CODEGEN_FRAMEWORKS)[number]

interface ParsedCommand {
  url?: string
  output?: string
  mode: "single" | "bundle"
  framework?: CodegenFramework
  allowPrivateHosts: boolean
  help: boolean
}

interface WebCloneEnvelope {
  ok: boolean
  result?: { output: string; stats: Record<string, number>; mode: string }
  error?: { name: string; message: string; reason?: string }
}

const USAGE =
  "Usage: /web-clone <url> [-o <output>] [-m single|bundle] [--framework vue|react|angular|svelte|jquery] [--private]"

/** Parse the raw slash-command argument string into a structured request. */
export function parseWebCloneArgs(raw: string): ParsedCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const parsed: ParsedCommand = { mode: "bundle", allowPrivateHosts: false, help: false }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === "-h" || tok === "--help") {
      parsed.help = true
    } else if (tok === "-o" || tok === "--output") {
      parsed.output = tokens[++i]
    } else if (tok === "-m" || tok === "--mode") {
      const v = tokens[++i]
      if (v === "single" || v === "bundle") parsed.mode = v
    } else if (tok === "--single") {
      parsed.mode = "single"
    } else if (tok === "--framework") {
      const v = tokens[++i]
      if (v && (CODEGEN_FRAMEWORKS as readonly string[]).includes(v))
        parsed.framework = v as CodegenFramework
    } else if (tok === "--private") {
      parsed.allowPrivateHosts = true
    } else if (!tok.startsWith("-") && !parsed.url) {
      parsed.url = tok
    }
  }
  return parsed
}

/** True for an absolute POSIX or Windows path. */
function isAbsolutePath(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
}

/** A filesystem-safe token derived from the URL host, for the default output dir. */
function safeHostSlug(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_") || "snapshot"
  } catch {
    return "snapshot"
  }
}

/**
 * Resolve the output path to an absolute path. Explicit absolute paths pass
 * through; otherwise the output resolves under the open Source-Control
 * workspace (`snapshots/<host>-<stamp>` by default). `stamp` is injected for
 * deterministic tests.
 */
export function resolveOutput(
  parsed: ParsedCommand,
  rootDir: string | null,
  stamp: string
): string {
  const explicit = parsed.output
  if (explicit && isAbsolutePath(explicit)) return explicit
  if (!rootDir) {
    throw new Error(
      "no open workspace — open a folder in Source Control, or pass an absolute path with -o"
    )
  }
  const sep = rootDir.includes("\\") ? "\\" : "/"
  const base = rootDir.replace(/[\\/]+$/, "")
  if (explicit) return base + sep + explicit.replace(/^[\\/]+/, "")
  const dir = `snapshots${sep}${safeHostSlug(parsed.url ?? "")}-${stamp}`
  const suffix = parsed.mode === "single" ? ".html" : ""
  return base + sep + dir + suffix
}

/** Build the runner job from a parsed command + resolved absolute output. */
export function buildJob(parsed: ParsedCommand, output: string): Record<string, unknown> {
  const wantsCodegen = Boolean(parsed.framework)
  const options: Record<string, unknown> = {
    url: parsed.url,
    output,
    mode: parsed.mode,
    maxAssets: 100,
    concurrency: 6,
    timeout: 15000,
    retryCount: 1,
    retryInitialDelay: 200,
    retryMaxDelay: 2000,
    inline: true,
    pretty: false,
    extractComponents: wantsCodegen,
    allowPrivateHosts: parsed.allowPrivateHosts,
  }
  if (wantsCodegen) {
    options.frameworkCodegen = {
      framework: parsed.framework,
      typescript: true,
      cssModules: false,
      generateDrafts: false,
      extractSharedLogic: false,
    }
  }
  return { mode: "snapshot", url: parsed.url, options }
}

/** Run a parsed `/web-clone` command. Exported for tests (deps injectable). */
export async function runWebCloneCommand(
  raw: string,
  deps: {
    invoke: (cmd: string, args: Record<string, unknown>) => Promise<{ envelope: WebCloneEnvelope }>
    rootDir: () => string | null
    now: () => number
  }
): Promise<{ message: string }> {
  const parsed = parseWebCloneArgs(raw)
  if (parsed.help || !parsed.url) {
    return { message: parsed.url ? USAGE : `Snapshot a web page to disk.\n${USAGE}` }
  }
  let output: string
  try {
    output = resolveOutput(parsed, deps.rootDir(), String(deps.now()))
  } catch (err) {
    return { message: `web-clone: ${err instanceof Error ? err.message : String(err)}` }
  }
  const job = buildJob(parsed, output)
  try {
    const { envelope } = await deps.invoke("web_clone_snapshot", { job })
    if (!envelope.ok || !envelope.result) {
      return { message: `web-clone failed: ${envelope.error?.message ?? "unknown error"}` }
    }
    const r = envelope.result
    const fetched = r.stats.fetched ?? 0
    const total = r.stats.total ?? 0
    return { message: `Snapshot written to ${r.output} (${fetched}/${total} assets fetched).` }
  } catch (err) {
    return { message: `web-clone failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-web-clone",
    name: "Web Clone",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["commands"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("web-clone plugin activated")
    registerSlashCommand({
      id: "web-clone.snapshot",
      name: "/web-clone",
      description: "Snapshot a web page (HTML + assets) to a self-contained file or bundle.",
      category: "plugins",
      handler: async (args: string) => {
        if (!isTauri()) {
          return { message: "web-clone runs only on the desktop app." }
        }
        const { invoke } = await import("@tauri-apps/api/core")
        return runWebCloneCommand(args, {
          invoke: (cmd, a) =>
            invoke<{ envelope: WebCloneEnvelope }>(cmd, a as Record<string, unknown>),
          rootDir: () => useGitStore.getState().rootDir,
          now: () => Date.now(),
        })
      },
      source: "plugin",
      pluginId: ctx.pluginId,
    })
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
    }
  },
}

export default definition
