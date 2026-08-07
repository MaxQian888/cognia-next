import type { AgentTeamAvatarId, TeamMemberRole } from "@/types/agent/agent-team"

export const AGENT_TEAM_AVATAR_IDS = [
  "coordinator",
  "researcher",
  "coder",
  "designer",
  "planner",
  "data-analyst",
  "writer",
  "browser-scout",
  "workflow-engineer",
  "memory-archivist",
  "security-guardian",
  "reviewer",
  "operator",
  "translator",
  "creative-agent",
  "general-assistant",
] as const satisfies readonly AgentTeamAvatarId[]

const TEAMMATE_AVATAR_IDS = AGENT_TEAM_AVATAR_IDS.filter(
  (avatarId): avatarId is Exclude<AgentTeamAvatarId, "coordinator"> => avatarId !== "coordinator"
)

const ROLE_MATCHERS: ReadonlyArray<{
  avatarId: Exclude<AgentTeamAvatarId, "coordinator">
  keywords: readonly string[]
}> = [
  {
    avatarId: "security-guardian",
    keywords: ["security", "safety", "permission", "安全", "权限"],
  },
  {
    avatarId: "workflow-engineer",
    keywords: ["workflow", "automation", "pipeline", "工作流", "自动化"],
  },
  {
    avatarId: "data-analyst",
    keywords: ["data", "analyst", "metric", "analytics", "数据", "分析", "指标"],
  },
  {
    avatarId: "browser-scout",
    keywords: ["browser", "web", "search", "retrieval", "research source", "浏览", "搜索", "检索"],
  },
  {
    avatarId: "memory-archivist",
    keywords: ["memory", "archive", "knowledge", "记忆", "归档", "知识"],
  },
  {
    avatarId: "reviewer",
    keywords: ["review", "audit", "quality", "qa", "test", "审查", "审核", "评审", "测试"],
  },
  {
    avatarId: "translator",
    keywords: ["translate", "translation", "localization", "i18n", "翻译", "本地化", "国际化"],
  },
  {
    avatarId: "researcher",
    keywords: ["research", "investigate", "study", "研究", "调研", "调查"],
  },
  {
    avatarId: "designer",
    keywords: ["design", "designer", "ui", "ux", "visual", "设计", "视觉"],
  },
  {
    avatarId: "planner",
    keywords: ["plan", "planning", "strategy", "roadmap", "规划", "计划", "策略"],
  },
  {
    avatarId: "writer",
    keywords: ["write", "writer", "content", "copy", "文案", "写作", "内容"],
  },
  {
    avatarId: "operator",
    keywords: ["operator", "operations", "devops", "deploy", "运维", "部署", "运营"],
  },
  {
    avatarId: "coder",
    keywords: ["code", "coder", "developer", "engineer", "programming", "开发", "编程", "工程师"],
  },
  {
    avatarId: "creative-agent",
    keywords: ["creative", "ideation", "brainstorm", "创意", "创作", "脑暴"],
  },
  {
    avatarId: "general-assistant",
    keywords: ["assistant", "helper", "general", "助手", "助理", "通用"],
  },
]

export interface AgentTeamAvatarSubject {
  id: string
  name: string
  description?: string
  specialization?: string
  role?: TeamMemberRole
  avatarId?: AgentTeamAvatarId
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function containsKeyword(searchable: string, keyword: string): boolean {
  if (/[^\u0000-\u007f]/.test(keyword)) return searchable.includes(keyword)
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9])${escaped}[a-z]*($|[^a-z0-9])`, "i").test(searchable)
}

function getRoleMatch(subject: AgentTeamAvatarSubject): AgentTeamAvatarId | undefined {
  const searchable = [subject.name, subject.description, subject.specialization]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()

  return ROLE_MATCHERS.find(({ keywords }) =>
    keywords.some((keyword) => containsKeyword(searchable, keyword))
  )?.avatarId
}

export function resolveAgentTeamAvatarId(subject: AgentTeamAvatarSubject): AgentTeamAvatarId {
  if (subject.avatarId) return subject.avatarId
  if (subject.role === "lead") return "coordinator"

  const roleMatch = getRoleMatch(subject)
  if (roleMatch) return roleMatch

  return TEAMMATE_AVATAR_IDS[
    stableHash(`${subject.id}:${subject.name}`) % TEAMMATE_AVATAR_IDS.length
  ]
}

export function assignAgentTeamAvatarId(
  subject: AgentTeamAvatarSubject,
  usedAvatarIds: ReadonlySet<AgentTeamAvatarId>
): AgentTeamAvatarId {
  const preferred = resolveAgentTeamAvatarId(subject)
  if (!usedAvatarIds.has(preferred)) return preferred

  const startIndex = stableHash(`${subject.id}:${subject.name}`) % TEAMMATE_AVATAR_IDS.length
  for (let offset = 0; offset < TEAMMATE_AVATAR_IDS.length; offset += 1) {
    const candidate = TEAMMATE_AVATAR_IDS[(startIndex + offset) % TEAMMATE_AVATAR_IDS.length]
    if (!usedAvatarIds.has(candidate)) return candidate
  }

  return preferred
}

export function getAgentTeamAvatarPath(avatarId: AgentTeamAvatarId): string {
  return `/icons/cognia-agent-team/webp/${avatarId}.webp`
}
