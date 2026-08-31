export interface ResidentSkillHostPolicy {
  id: string
  owner:
    | "artifact-host"
    | "computer-use-host"
    | "connector-host"
    | "execution-host"
    | "network-host"
    | "onboarding-host"
    | "twin-host"
    | "workflow-host"
    | "workspace-host"
}

/**
 * Audit binding from descriptor vocabulary to the host subsystem that enforces
 * it. This is metadata only: it never grants a tool or delegates enforcement
 * to model prose.
 */
export const SKILL_HOST_POLICY_OWNERS: Readonly<Record<string, ResidentSkillHostPolicy["owner"]>> =
  {
    "agent-depth-budget": "execution-host",
    "artifact-channel": "artifact-host",
    "audience-disclosure": "twin-host",
    "capability-preflight": "onboarding-host",
    "goal-budget": "execution-host",
    "host-consent": "computer-use-host",
    "human-handoff": "connector-host",
    "network-policy": "network-host",
    "permission-ceiling": "execution-host",
    "pii-gate": "network-host",
    "proposal-first": "workflow-host",
    "quiet-hours": "connector-host",
    "request-scope": "onboarding-host",
    "screenshot-grounding": "computer-use-host",
    "user-language": "execution-host",
    "workspace-confined": "workspace-host",
  }

export function resolveResidentSkillHostPolicies(
  ids: readonly string[]
): ResidentSkillHostPolicy[] {
  return [...new Set(ids)].sort().map((id) => {
    const owner = SKILL_HOST_POLICY_OWNERS[id]
    if (!owner) throw new Error(`Unknown built-in Skill host policy: ${id}`)
    return { id, owner }
  })
}
