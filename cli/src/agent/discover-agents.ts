/**
 * Discover `.cognia/agents/*.md` subagent definitions from disk and parse them
 * into dispatchable defs, reusing the desktop's `buildMarkdownAgents` parser.
 * Mirrors the Claude-Code `.claude/agents` convention; the file fs is injectable
 * for tests and defaults to a Node adapter.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { buildMarkdownAgents, type MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"
import { claudeCodeAdapter } from "@/lib/claude/subagent-importers/claude-code"
import { codexCliAdapter } from "@/lib/claude/subagent-importers/codex-cli"
import type {
  ImportFile,
  SubagentImportDraft,
  SubagentSourceAdapter,
} from "@/lib/claude/subagent-importers/types"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

import type { SubagentModelOverride } from "../config/schema"

/** The minimal fs surface discovery needs (matches `InstructionFs`). */
export interface AgentFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
}

const defaultFs: AgentFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
}

/** Collect agent markdown files from each root's `.cognia/agents` dir. First
 * root wins on an id collision (project overrides global). */
export async function discoverAgentFiles(
  roots: string[],
  fs: AgentFs = defaultFs
): Promise<MarkdownAgentFile[]> {
  const byId = new Map<string, MarkdownAgentFile>()
  for (const root of roots) {
    const dir = path.join(root, ".cognia", "agents")
    if (!(await fs.exists(dir))) continue
    const names = await fs.readDir(dir)
    for (const name of names) {
      if (!name.endsWith(".md")) continue
      const id = name.slice(0, -3)
      if (byId.has(id)) continue
      try {
        byId.set(id, { id, content: await fs.readText(path.join(dir, name)) })
      } catch {
        // unreadable file — skip
      }
    }
  }
  return [...byId.values()]
}

export interface AgentSummary {
  id: string
  name: string
  description: string
  def: PluginSubagentDef
}

/**
 * Overlay the user's per-subagent provider/model overrides
 * (`config.subagentModels`) onto a discovered agent set, so a `/agents models`
 * choice wins over each agent's markdown frontmatter before dispatch. Pure (a
 * fresh array; untouched agents are returned by reference). Semantics:
 *
 *   - `override.model` set → swap the def's `model`.
 *   - `override.provider` set → re-route the def's `provider`; when the override
 *     carries NO model, the frontmatter `model` is dropped so the new provider
 *     uses its own default (a frontmatter model rarely names a model the new
 *     provider can serve). The panel always pairs a provider with a model, so
 *     this only matters for a hand-edited provider-only entry.
 *
 * `buildChildConfig` then routes/auths the dispatch from the overlaid def, with
 * the same "unconfigured provider → fall back to parent" safety it already has.
 */
export function applySubagentModelOverrides(
  agents: AgentSummary[],
  overrides: Record<string, SubagentModelOverride> | undefined
): AgentSummary[] {
  if (!overrides || Object.keys(overrides).length === 0) return agents
  return agents.map((a) => {
    const ov = overrides[a.id]
    if (!ov || (!ov.model && !ov.provider)) return a
    const def: PluginSubagentDef = { ...a.def }
    if (ov.provider) {
      def.provider = ov.provider
      if (!ov.model) delete def.model
    }
    if (ov.model) def.model = ov.model
    return { ...a, def }
  })
}

/** Parse discovered files into `{ id, name, description, def }` rows. */
export function buildAgents(files: MarkdownAgentFile[]): AgentSummary[] {
  const { agents } = buildMarkdownAgents(files)
  return (
    Object.entries(agents)
      // `disabled: true` (alias `disable`) frontmatter turns the agent fully off
      // — same semantics as the desktop resolver. `hidden` only affects pickers.
      .filter(([, def]) => !def.disabled)
      .map(([name, def]) => ({
        id: name,
        name,
        description: def.description ?? "",
        def: {
          id: name,
          name,
          description: def.description ?? "",
          prompt: def.prompt ?? "",
          ...(def.tools ? { tools: def.tools } : {}),
          ...(def.model ? { model: def.model } : {}),
          ...(def.provider ? { provider: def.provider } : {}),
          ...(def.hidden ? { hidden: true } : {}),
        },
      }))
  )
}

/** Map an explicit/source-model provider hint onto Cognia's provider ids. */
function providerFromHint(hint: SubagentImportDraft["providerHint"]): string | undefined {
  if (hint === "gemini") return "google"
  return hint // "anthropic" | "openai" | undefined
}

/**
 * External coding-tool subagent sources the CLI autonomously reuses, so agents a
 * user already authored for Claude Code / Codex become dispatchable here without
 * a manual import. Each entry pairs one of the desktop's (pure) importer adapters
 * with the on-disk locations that tool writes under a root (project cwd OR home),
 * mirroring `.cognia/agents`'s `[cwd, home]` scan. We reuse the adapters rather
 * than reimplement parsing — they already handle frontmatter, the Codex YAML
 * array form, tool/model fields, and provider hints.
 */
interface ExternalAgentSource {
  adapter: SubagentSourceAdapter
  /** Per-agent dirs to scan, relative to a root (e.g. `.claude/agents`). */
  dirs: string[]
  /** Single multi-agent files, relative to a root (e.g. `.codex/agents.md`). */
  files: string[]
  /** Accepted extensions (lowercase, with the dot). */
  exts: string[]
}

const EXTERNAL_AGENT_SOURCES: ExternalAgentSource[] = [
  // Claude Code: `.claude/agents/<name>.md` (project) + `~/.claude/agents/...`.
  {
    adapter: claudeCodeAdapter,
    dirs: [path.join(".claude", "agents")],
    files: [],
    exts: [".md", ".markdown"],
  },
  // Codex CLI: `~/.codex/agents/<name>.md` (per-agent) + `~/.codex/agents.md`
  // (single-file YAML array). Both ride in when a project keeps a local `.codex`.
  {
    adapter: codexCliAdapter,
    dirs: [path.join(".codex", "agents")],
    files: [path.join(".codex", "agents.md")],
    exts: [".md", ".markdown", ".yaml", ".yml"],
  },
]

/** Read every accepted file for one external source across all roots into the
 * adapter's `ImportFile[]` shape. `sourcePath` keeps the dir hint (forward
 * slashes) so an adapter that inspects it still resolves correctly. Project
 * roots come first, so a later home-root duplicate loses on parse order. */
async function readExternalSourceFiles(
  source: ExternalAgentSource,
  roots: string[],
  fs: AgentFs
): Promise<ImportFile[]> {
  const out: ImportFile[] = []
  for (const root of roots) {
    for (const rel of source.dirs) {
      const dir = path.join(root, rel)
      if (!(await fs.exists(dir))) continue
      for (const name of await fs.readDir(dir)) {
        if (!source.exts.includes(path.extname(name).toLowerCase())) continue
        try {
          out.push({
            filename: name,
            sourcePath: path.join(rel, name).replace(/\\/g, "/"),
            content: await fs.readText(path.join(dir, name)),
          })
        } catch {
          // unreadable file — skip
        }
      }
    }
    for (const rel of source.files) {
      const fp = path.join(root, rel)
      if (!(await fs.exists(fp))) continue
      try {
        out.push({
          filename: path.basename(rel),
          sourcePath: rel.replace(/\\/g, "/"),
          content: await fs.readText(fp),
        })
      } catch {
        // unreadable file — skip
      }
    }
  }
  return out
}

/** Map an importer draft to a dispatchable summary. A source directory alone
 * does not opt into that source's provider: provider-agnostic `.claude/agents`
 * files must inherit the active TUI provider, otherwise a DeepSeek session can
 * unexpectedly launch an unauthenticated Anthropic child. An explicitly paired
 * model or `provider:` frontmatter still keeps the upstream provider. */
function draftToSummary(draft: SubagentImportDraft): AgentSummary {
  const description = draft.description ?? ""
  const hasExplicitProvider = Object.prototype.hasOwnProperty.call(
    draft.rawFrontmatter ?? {},
    "provider"
  )
  const provider =
    draft.model || hasExplicitProvider ? providerFromHint(draft.providerHint) : undefined
  return {
    id: draft.name,
    name: draft.name,
    description,
    def: {
      id: draft.name,
      name: draft.name,
      description,
      prompt: draft.systemPrompt,
      ...(draft.tools && draft.tools.length > 0 ? { tools: draft.tools } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(provider ? { provider } : {}),
    },
  }
}

/**
 * The full dispatchable agent set for the CLI: native `.cognia/agents/*.md`
 * UNIONed with autonomously-discovered Claude Code / Codex subagents. Native
 * agents WIN on an id collision (a `.cognia/agents/foo.md` overrides an external
 * `foo`); among external sources the registry order (Claude Code, then Codex)
 * breaks ties. Pure-ish: all disk reads go through the injectable `fs`, and a
 * failing source degrades to nothing rather than breaking discovery.
 */
export async function discoverDispatchableAgents(
  roots: string[],
  fs: AgentFs = defaultFs
): Promise<AgentSummary[]> {
  const byId = new Map<string, AgentSummary>()
  // Native first so they own their ids.
  for (const a of buildAgents(await discoverAgentFiles(roots, fs))) {
    if (!byId.has(a.id)) byId.set(a.id, a)
  }
  for (const source of EXTERNAL_AGENT_SOURCES) {
    let files: ImportFile[]
    try {
      files = await readExternalSourceFiles(source, roots, fs)
    } catch {
      continue
    }
    if (files.length === 0) continue
    let drafts: SubagentImportDraft[]
    try {
      drafts = source.adapter.parse({ files }).drafts
    } catch {
      continue
    }
    for (const draft of drafts) {
      const summary = draftToSummary(draft)
      if (summary.id && !byId.has(summary.id)) byId.set(summary.id, summary)
    }
  }
  return [...byId.values()]
}
