/**
 * Markdown-defined subagents.
 *
 * Lets users declare custom subagents as `*.md` files (frontmatter +
 * body) under a project `.cognia/agents/` dir or a global agents dir —
 * the same ergonomics as OpenCode / Claude Code agents. Reuses the
 * existing `gray-matter` frontmatter parser (already a dependency, used
 * by `lib/claude/skills-io.ts`) instead of inventing a new one.
 *
 * This module is the PURE parse + merge layer. Filesystem discovery is
 * injected (a `{ id, content }[]` list) so it stays platform-agnostic and
 * unit-testable; the Tauri/global-dir wiring lives at the call site and
 * merges the result into `lib/claude/agents/subagents/index.ts`'s
 * `resolveAllSubagents`.
 *
 * Frontmatter:
 *   description: string        (help shown to the dispatcher)
 *   model:       string?       (sonnet/opus/haiku or full id)
 *   provider:    string?       (anthropic/openai/deepseek/… — run on a different
 *                               provider than the session; pairs with `model`)
 *   tools | allowed-tools:     string[] | comma-string  (allowlist)
 *   disallowedTools | disallowed-tools: string[] | comma-string
 * Body = the subagent's system prompt.
 */

import matter from "gray-matter"
import type { AgentDefinition } from "./subagents/types"

export interface MarkdownAgentResult {
  /** Successfully parsed agents keyed by id (later files override earlier). */
  agents: Record<string, AgentDefinition>
  /** Human-readable warnings for skipped/malformed files. */
  warnings: string[]
}

export interface MarkdownAgentFile {
  /** Stable id (typically the filename without extension, kebab-case). */
  id: string
  /** Raw file contents (frontmatter + body). */
  content: string
}

export interface ParsedMarkdownAgent {
  id: string
  def: AgentDefinition
  /** Frontmatter fields understood by Claude Code but not by AgentDefinition. */
  unsupportedFields: string[]
}

/** Serialize the portable Claude Code plugin-agent field set. */
export function serializeMarkdownAgent(id: string, def: AgentDefinition): string {
  const data: Record<string, unknown> = {
    name: id,
    description: def.description,
  }
  if (def.model) data.model = def.model
  if (def.effort) data.effort = def.effort
  if (def.maxTurns) data.maxTurns = def.maxTurns
  if (def.tools?.length) data.tools = [...def.tools]
  if (def.disallowedTools?.length) data.disallowedTools = [...def.disallowedTools]
  const body = def.prompt.endsWith("\n") ? def.prompt : `${def.prompt}\n`
  return matter.stringify(body, data)
}

function normalizeToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }
  if (typeof value === "string") {
    const arr = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return arr.length ? arr : undefined
  }
  return undefined
}

/**
 * Parse a single markdown agent file. Returns the AgentDefinition or an
 * error string (never throws — malformed files are reported, not fatal).
 */
export function parseMarkdownAgent(
  id: string,
  content: string
): ParsedMarkdownAgent | { id: string; error: string } {
  let data: Record<string, unknown>
  let body: string
  try {
    const parsed = matter(content)
    data = (parsed.data ?? {}) as Record<string, unknown>
    body = parsed.content ?? ""
  } catch (err) {
    return {
      id,
      error: `frontmatter parse failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const prompt = body.trim()
  if (!prompt) return { id, error: "empty body (no system prompt)" }

  const description = typeof data.description === "string" ? data.description.trim() : ""
  if (!description) return { id, error: "missing `description` frontmatter" }

  const def: AgentDefinition = { description, prompt }

  if (typeof data.model === "string" && data.model.trim()) def.model = data.model.trim()

  // Provider override — lets a `.cognia/agents/*.md` run on a different provider
  // than the active session (e.g. `provider: anthropic` + `model: sonnet`).
  if (typeof data.provider === "string" && data.provider.trim()) {
    def.provider = data.provider.trim()
  }

  const tools = normalizeToolList(data.tools ?? data["allowed-tools"])
  if (tools) def.tools = tools

  const disallowed = normalizeToolList(data.disallowedTools ?? data["disallowed-tools"])
  if (disallowed) def.disallowedTools = disallowed

  const maxTurns = data.maxTurns ?? data["max-turns"]
  if (typeof maxTurns === "number" && Number.isInteger(maxTurns) && maxTurns > 0) {
    def.maxTurns = maxTurns
  } else if (
    typeof maxTurns === "string" &&
    /^\d+$/.test(maxTurns.trim()) &&
    Number(maxTurns) > 0
  ) {
    def.maxTurns = Number(maxTurns)
  }

  const effort = data.effort
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    def.effort = effort
  }

  const externalPreset = data.externalPresetId ?? data["external-preset-id"]
  if (typeof externalPreset === "string" && externalPreset.trim()) {
    def.externalPresetId = externalPreset.trim()
  }

  // MCP servers to forward into an external-preset-backed subagent's ACP session.
  const mcpServerIds = normalizeToolList(data.mcpServerIds ?? data["mcp-server-ids"])
  if (mcpServerIds) def.mcpServerIds = mcpServerIds

  // Nested dispatch opt-in (depth-N subagents).
  const allowNesting = data.allowNesting ?? data["allow-nesting"]
  if (allowNesting === true || allowNesting === "true") def.allowNesting = true

  const maxDepth = data.maxDepth ?? data["max-depth"]
  if (typeof maxDepth === "number" && Number.isFinite(maxDepth)) {
    def.maxDepth = maxDepth
  } else if (typeof maxDepth === "string" && maxDepth.trim() && !Number.isNaN(Number(maxDepth))) {
    def.maxDepth = Number(maxDepth)
  }

  // Visibility flags (OpenCode parity): `hidden` keeps the agent dispatchable
  // but out of pickers; `disabled` (alias `disable`) turns it fully off.
  const hidden = data.hidden
  if (hidden === true || hidden === "true") def.hidden = true
  const disabled = data.disabled ?? data.disable
  if (disabled === true || disabled === "true") def.disabled = true

  const unsupportedFields = [
    "skills",
    "memory",
    "background",
    "isolation",
    "hooks",
    "mcpServers",
    "permissionMode",
  ].filter((key) => {
    const value = data[key]
    if (value === undefined || value === null || value === false) return false
    if (typeof value === "string") return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    return true
  })
  const declaredName = typeof data.name === "string" ? data.name.trim() : ""
  return { id: declaredName || id, def, unsupportedFields }
}

/**
 * Parse and merge a list of markdown agent files into a single map.
 * Files later in the list override earlier ones by id — pass global
 * agents first and project agents last so project wins.
 */
export function buildMarkdownAgents(files: MarkdownAgentFile[]): MarkdownAgentResult {
  const agents: Record<string, AgentDefinition> = {}
  const warnings: string[] = []
  for (const file of files) {
    const result = parseMarkdownAgent(file.id, file.content)
    if ("error" in result) {
      warnings.push(`agent "${file.id}": ${result.error}`)
      continue
    }
    if (result.unsupportedFields.length > 0) {
      warnings.push(
        `agent "${result.id}": unsupported frontmatter fields: ${result.unsupportedFields.join(", ")}`
      )
    }
    agents[result.id] = result.def
  }
  return { agents, warnings }
}

/**
 * Project markdown agents into the SDK `Record<string, Record<string,
 * unknown>>` shape consumed by `SendOptions.agents`, mirroring how
 * `subagents/index.ts` spreads its built-ins.
 */
export function markdownAgentsToSdkMap(
  agents: Record<string, AgentDefinition>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, def] of Object.entries(agents)) {
    out[id] = def as unknown as Record<string, unknown>
  }
  return out
}
