/**
 * The two read-only agent tools (ADR-0238 §12). They return what the view
 * shows, as data: the latest audit's findings and the latest adherence
 * replay, for the workspace of the conversation that called them. Neither
 * writes; applying a change or adopting a rule stays in the view, behind the
 * host's per-surface confirmation.
 */
import { definePluginTool, type PluginToolContext } from "@cognia/plugin-sdk"

import { followRate, verdictOf } from "./adherence/backtest"
import type { GovernanceRuntime } from "./runtime/runtime"
import { ADHERENCE_TOOL, REPORT_TOOL } from "./skill"

export const REFRESH_SCHEMA = {
  type: "object",
  properties: {
    refresh: {
      type: "boolean",
      description: "Re-run before answering instead of returning the stored result.",
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: 100,
      description: "Findings or checks to return (default 30).",
    },
  },
} as const

/** A tool run may audit dozens of surfaces with a model call each. */
export const TOOL_TIMEOUT_MS = 600_000

export interface ToolArgs {
  refresh?: boolean
  limit?: number
}

function limitOf(args: ToolArgs): number {
  const value = typeof args.limit === "number" ? Math.floor(args.limit) : 30
  return Math.min(100, Math.max(1, value))
}

async function workspaceFor(
  runtime: GovernanceRuntime,
  sessionWorkspace: (sessionId: string) => Promise<string | null>,
  toolCtx?: PluginToolContext
): Promise<string | null> {
  if (toolCtx?.sessionId) {
    const fromSession = await sessionWorkspace(toolCtx.sessionId)
    if (fromSession) return fromSession
  }
  return runtime.defaultWorkspace()
}

function errorResult(error: unknown) {
  return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
}

export async function reportTool(
  runtime: GovernanceRuntime,
  sessionWorkspace: (sessionId: string) => Promise<string | null>,
  args: ToolArgs,
  toolCtx?: PluginToolContext
) {
  try {
    const workspaceId = await workspaceFor(runtime, sessionWorkspace, toolCtx)
    if (args.refresh) await runtime.audit(workspaceId)
    const run = await runtime.latestRun(workspaceId)
    if (!run) return { ok: true as const, workspaceId, audited: false as const }
    const kept = await runtime.store.keptFindings(workspaceId)
    const findings = (await runtime.findings(workspaceId)).filter(
      (finding) => !kept.has(finding.id)
    )
    const names = new Map(run.surfaces.map((entry) => [entry.surface.key, entry.surface.name]))
    return {
      ok: true as const,
      workspaceId,
      audited: true as const,
      auditedAt: new Date(run.finishedAt).toISOString(),
      targetModel: run.targetModel,
      surfaces: run.surfaces.length,
      failedSources: run.failedSources,
      totalFindings: findings.length,
      keptByUser: kept.size,
      findings: findings.slice(0, limitOf(args)).map((finding) => ({
        id: finding.id,
        group: finding.group,
        pattern: finding.pattern,
        // A key carries a path; without a name, only its owner is shown.
        surface:
          names.get(finding.location.surfaceKey) ?? finding.location.surfaceKey.split(":")[0],
        ...(finding.location.startLine !== undefined
          ? {
              lines: [
                finding.location.startLine,
                finding.location.endLine ?? finding.location.startLine,
              ],
            }
          : {}),
        evidence: runtime.forModel(finding.evidence),
        ...(finding.reason ? { reason: runtime.forModel(finding.reason) } : {}),
        confidence: finding.confidence,
        action: finding.action,
        hasProposedEdit: run.hunks.some((hunk) => hunk.findingId === finding.id),
      })),
    }
  } catch (error) {
    return errorResult(error)
  }
}

export async function adherenceTool(
  runtime: GovernanceRuntime,
  sessionWorkspace: (sessionId: string) => Promise<string | null>,
  args: ToolArgs,
  toolCtx?: PluginToolContext
) {
  try {
    const workspaceId = await workspaceFor(runtime, sessionWorkspace, toolCtx)
    const checks = await runtime.store.checks(workspaceId)
    if (!checks) return { ok: true as const, workspaceId, derived: false as const }
    if (args.refresh) await runtime.backtest(workspaceId)
    const adherence = await runtime.store.adherence(workspaceId)
    const results = new Map((adherence?.results ?? []).map((result) => [result.checkId, result]))
    return {
      ok: true as const,
      workspaceId,
      derived: true as const,
      ...(adherence
        ? { replayedAt: new Date(adherence.ranAt).toISOString(), sessions: adherence.sessions }
        : {}),
      checks: checks.checks.slice(0, limitOf(args)).map((check) => {
        const result = results.get(check.id)
        return {
          id: check.id,
          rule: runtime.forModel(check.rule.text),
          surface: check.rule.surfaceName,
          line: check.rule.startLine,
          kind: check.kind,
          summary: check.summary,
          ...(result
            ? {
                verdict: verdictOf(check, result),
                opportunities: result.opportunities,
                followed: result.followed,
                violated: result.violated,
                ...(followRate(result) !== undefined ? { followRate: followRate(result) } : {}),
              }
            : {}),
        }
      }),
    }
  } catch (error) {
    return errorResult(error)
  }
}

export function createGovernanceTools(
  runtime: GovernanceRuntime,
  sessionWorkspace: (sessionId: string) => Promise<string | null>
) {
  return [
    definePluginTool({
      name: REPORT_TOOL,
      definition: {
        name: REPORT_TOOL,
        description:
          "Read the latest audit of this workspace's agent configuration (instruction files, Skills, agents, prompts): findings with location, quoted evidence, pattern, confidence and proposed action. refresh=true re-runs the audit first (model calls). Read-only: changes are applied by the user in the Config Governance view.",
        requiresApproval: false,
        timeoutMs: TOOL_TIMEOUT_MS,
        parametersSchema: REFRESH_SCHEMA,
      },
      execute: (args: Record<string, unknown>, toolCtx?: PluginToolContext) =>
        reportTool(runtime, sessionWorkspace, args as ToolArgs, toolCtx),
    }),
    definePluginTool({
      name: ADHERENCE_TOOL,
      definition: {
        name: ADHERENCE_TOOL,
        description:
          "Read how often each checkable rule of this workspace's agent configuration was followed in past sessions. refresh=true replays the checks over recent sessions first (local, no model call). Read-only.",
        requiresApproval: false,
        timeoutMs: TOOL_TIMEOUT_MS,
        parametersSchema: REFRESH_SCHEMA,
      },
      execute: (args: Record<string, unknown>, toolCtx?: PluginToolContext) =>
        adherenceTool(runtime, sessionWorkspace, args as ToolArgs, toolCtx),
    }),
  ]
}
