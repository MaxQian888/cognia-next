import { DENY_MODEL_GATE, distillInbound } from "@/lib/inbound/distiller"

export type FindingAuthorKind = "team_member" | "subagent" | "external_agent"

export interface AgentMemoryFinding {
  authorId: string
  authorKind: FindingAuthorKind
  title: string
  body: string
  kind: "fact" | "procedure" | "instruction"
  projectId?: string
  sessionId?: string
}

/**
 * Agent-derived knowledge is always a private pending draft. Existing inbound
 * acceptance is the only path that can promote it into Memory or a disabled Skill.
 */
export async function submitAgentMemoryFinding(finding: AgentMemoryFinding) {
  const outcome = await distillInbound(
    {
      kind: finding.kind === "fact" ? "lesson" : "skill",
      title: finding.title,
      body: finding.body,
      origin: "agent-finding",
      source: finding.authorId,
      metadata: {
        authorKind: finding.authorKind,
        trust: finding.authorKind === "external_agent" ? "untrusted" : "private",
        findingKind: finding.kind,
        ...(finding.projectId ? { projectId: finding.projectId } : {}),
        ...(finding.sessionId ? { sessionId: finding.sessionId } : {}),
        promotion: "supervisor_or_user_required",
      },
      fieldLabels: { title: "title", body: "finding" },
    },
    { gate: DENY_MODEL_GATE }
  )
  if (outcome.status === "rejected") throw new Error(outcome.reason)
  return outcome
}
