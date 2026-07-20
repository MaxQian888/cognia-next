// Adapters that turn CCSwitch table rows into cognia-next's existing import
// shapes, then delegate to the existing per-domain import paths. We never
// add a parallel storage table for CCSwitch entries — the destination is
// always cognia-next's own `mcpServers` / `promptPresets` / `skills` tables.

import type { McpImportDraft, McpImportStrategy } from "@/lib/db/mcp-servers"
import { bulkImportMcpServers } from "@/lib/db/mcp-servers"
import { createPreset } from "@/lib/db/prompt-presets"
import { createSkill } from "@/lib/db/skills"
import { listSkills } from "@/lib/db/skills"
import type { McpTransport } from "@cognia/agent-config-types"

import { presetById } from "@/lib/subscription/limits/custom/presets"

import type {
  CcswitchMcpServer,
  CcswitchPrompt,
  CcswitchProvider,
  CcswitchSkill,
} from "@/types/ccswitch"
import type { CustomLimitsSource } from "@/types/subscription"

/* ---- Provider usage metadata ------------------------------------------ */

export type CcswitchUsageImportFailure =
  | "missing-script"
  | "missing-credentials"
  | "unsupported-template"
  | "unsupported-provider"
  | "invalid-endpoint"

export type CcswitchUsageImportResult =
  | { ok: true; source: CustomLimitsSource }
  | { ok: false; reason: CcswitchUsageImportFailure }

function endpointParts(raw: string): { baseUrl: string; path: string } | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return { baseUrl: url.origin, path: `${url.pathname}${url.search}` || "/" }
  } catch {
    return null
  }
}

function usageSourceDraft(provider: CcswitchProvider): CustomLimitsSource | null {
  const script = provider.usageScript
  const token = script?.apiKey?.trim() || script?.accessToken?.trim() || provider.apiKey?.trim()
  const endpoint = script?.baseUrl?.trim() || provider.baseUrl?.trim()
  if (!token || !endpoint) return null
  const parts = endpointParts(endpoint)
  if (!parts) return null
  const intervalMinutes = script?.autoQueryInterval
  return {
    id: `ccswitch:${provider.kind ?? "provider"}:${provider.id}`,
    name: provider.name.trim() || provider.id,
    baseUrl: parts.baseUrl,
    token,
    enabled: false,
    refreshIntervalMs:
      typeof intervalMinutes === "number" && intervalMinutes > 0
        ? Math.min(intervalMinutes, 1440) * 60_000
        : undefined,
    request: { path: parts.path },
    extract: { kind: "balance", remainingPath: "" },
  }
}

/**
 * Convert only CCSwitch's recognized template metadata. The script body is
 * deliberately ignored: importing arbitrary JavaScript would turn a read-only
 * database integration into remote-code execution with renderer credentials.
 */
export function fromCcswitchUsageScript(
  provider: CcswitchProvider
): CcswitchUsageImportResult {
  const script = provider.usageScript
  if (!script) return { ok: false, reason: "missing-script" }
  const endpoint = script.baseUrl?.trim() || provider.baseUrl?.trim()
  const token = script.apiKey?.trim() || script.accessToken?.trim() || provider.apiKey?.trim()
  if (!endpoint || !endpointParts(endpoint)) return { ok: false, reason: "invalid-endpoint" }
  if (!token) return { ok: false, reason: "missing-credentials" }
  const draft = usageSourceDraft(provider)
  if (!draft) return { ok: false, reason: "invalid-endpoint" }

  if (script.templateType === "token_plan") {
    if (script.codingPlanProvider === "zhipu_team") {
      if (!script.teamOrganizationId?.trim() || !script.teamProjectId?.trim()) {
        return { ok: false, reason: "missing-credentials" }
      }
      const source = presetById("glm-coding").apply(draft)
      source.request = {
        ...source.request,
        path: "/api/monitor/usage/quota/limit?type=2",
        headers: {
          ...(source.request.headers ?? {}),
          "bigmodel-organization": script.teamOrganizationId.trim(),
          "bigmodel-project": script.teamProjectId.trim(),
        },
      }
      return { ok: true, source }
    }
    const presetId =
      script.codingPlanProvider === "kimi"
        ? "kimi-coding"
        : script.codingPlanProvider === "zhipu"
          ? "glm-coding"
          : script.codingPlanProvider === "minimax"
            ? "minimax-token-plan"
            : script.codingPlanProvider === "zenmux"
              ? "zenmux"
              : null
    if (!presetId) return { ok: false, reason: "unsupported-provider" }
    const source = presetById(presetId).apply(draft)
    // ZenMux stores the complete quota URL rather than an inference base URL.
    if (presetId === "zenmux") source.request.path = draft.request.path
    return { ok: true, source }
  }

  if (script.templateType === "newapi") {
    const source = presetById("new-api").apply(draft)
    if (script.userId) {
      source.request.headers = {
        ...(source.request.headers ?? {}),
        "New-Api-User": script.userId,
      }
    }
    return { ok: true, source }
  }

  if (script.templateType === "github_copilot") {
    return { ok: true, source: presetById("github-copilot").apply(draft) }
  }

  return { ok: false, reason: "unsupported-template" }
}

/* ---- MCP servers ------------------------------------------------------- */

const VALID_TRANSPORTS: McpTransport[] = ["stdio", "sse", "http"]

function pickTransport(raw: unknown): McpTransport {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase()
    if ((VALID_TRANSPORTS as string[]).includes(lower)) return lower as McpTransport
  }
  return "stdio"
}

/**
 * CCSwitch stores the MCP config as either a parsed object (`config: {...}`)
 * or a stringified JSON. Tolerate both.
 */
function configAsObject(value: CcswitchMcpServer["config"]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function fromCcswitchMcp(server: CcswitchMcpServer): McpImportDraft {
  const cfg = configAsObject(server.config)
  // CCSwitch tends to embed the transport in the config blob too; the
  // top-level field wins when present, otherwise inspect the blob.
  const transport = pickTransport(server.transport ?? cfg.type ?? cfg.transport)
  // Strip the duplicate transport hint so it doesn't double-up in cognia's
  // McpServer.config (which forwards as-is to the SDK). The leading-underscore
  // names mark the destructured aliases as intentionally unused.
  const { type: _t, transport: _u, ...rest } = cfg
  void _t
  void _u
  return {
    name: server.name.trim(),
    transport,
    config: rest,
  }
}

export interface McpImportSummary {
  imported: number
  updated: number
  skipped: number
  errored: Array<{ name: string; error: string }>
}

export async function importCcswitchMcp(
  selected: CcswitchMcpServer[],
  strategy: McpImportStrategy = "skip"
): Promise<McpImportSummary> {
  const drafts = selected.map(fromCcswitchMcp).filter((d) => d.name.length > 0)
  const result = await bulkImportMcpServers(drafts, strategy)
  return {
    imported: result.created,
    updated: result.updated,
    skipped: result.skipped,
    errored: result.errored,
  }
}

/* ---- Prompts ----------------------------------------------------------- */

export interface PromptImportSummary {
  imported: number
  errored: Array<{ name: string; error: string }>
}

/**
 * Each CCSwitch prompt becomes a fresh cognia-next prompt preset. Built-in
 * cognia-next presets are never touched; collisions on user-created names
 * are not de-duped (the user can rename later — preset names aren't unique).
 */
export async function importCcswitchPrompts(
  selected: CcswitchPrompt[]
): Promise<PromptImportSummary> {
  const summary: PromptImportSummary = { imported: 0, errored: [] }
  for (const p of selected) {
    const name = p.name.trim()
    const content = p.content.trim()
    if (!name || !content) {
      summary.errored.push({
        name: name || "(unnamed)",
        error: "missing name or content",
      })
      continue
    }
    try {
      await createPreset({
        name,
        content,
        description: p.description,
        category: "general",
      })
      summary.imported += 1
    } catch (err) {
      summary.errored.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}

/* ---- Skills ------------------------------------------------------------ */

export interface SkillImportSummary {
  imported: number
  skipped: Array<{ name: string; reason: string }>
  errored: Array<{ name: string; error: string }>
}

/**
 * Each CCSwitch skill becomes a fresh cognia-next skill row.
 *   - Skills with no body (`content` empty) are skipped — CCSwitch was
 *     pointing at an external file and cognia-next stores skill markdown
 *     inline; the user must re-import via the Skills section to materialize
 *     a proper cognia-native skill.
 *   - Name collisions are skipped to mirror MCP "existing wins" semantics.
 */
export async function importCcswitchSkills(selected: CcswitchSkill[]): Promise<SkillImportSummary> {
  const summary: SkillImportSummary = {
    imported: 0,
    skipped: [],
    errored: [],
  }
  const existing = await listSkills()
  const byName = new Set(existing.map((s) => s.name.trim().toLowerCase()))

  for (const s of selected) {
    const name = s.name.trim()
    if (!name) {
      summary.errored.push({ name: "(unnamed)", error: "missing name" })
      continue
    }
    if (!s.content?.trim()) {
      summary.skipped.push({
        name,
        reason: "external file — re-import via Skills section",
      })
      continue
    }
    if (byName.has(name.toLowerCase())) {
      summary.skipped.push({ name, reason: "name already in use" })
      continue
    }
    try {
      await createSkill({
        name,
        content: s.content,
        description: s.description,
        source: "custom",
        status: "enabled",
      })
      byName.add(name.toLowerCase())
      summary.imported += 1
    } catch (err) {
      summary.errored.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return summary
}
