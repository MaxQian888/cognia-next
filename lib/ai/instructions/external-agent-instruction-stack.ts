// Adapted to cognia-next's existing skills system. The upstream Cognia
// version assumed a `Skill` shape with `metadata.name` / `metadata.description`
// and a `Project` model with a `knowledgeBase` array. cognia-next's `Skill`
// (in `lib/claude/types`) carries `name`, `description`, `content` directly,
// and there is no Project model yet — we use a lightweight stub.
import { buildProjectContext } from "@cognia/document/knowledge-rag"
import { buildProgressiveSkillsPrompt } from "@/lib/skills/executor"
import type { Skill } from "@cognia/agent-config-types"
import type { Project } from "@/types"

export interface GlobalCustomInstructionsInput {
  customInstructionsEnabled?: boolean
  aboutUser?: string
  responsePreferences?: string
  customInstructions?: string
}

export interface ExternalAgentInstructionStackInput extends GlobalCustomInstructionsInput {
  baseSystemPrompt?: string
  activeSkills?: Skill[]
  project?: Project
  userQuery?: string
  workingDirectory?: string
  maxSkillsTokens?: number
}

export interface ExternalAgentInstructionStackResult {
  systemPrompt: string
  instructionHash: string
  developerInstructions: string
  customInstructionsSection: string
  skillsSummary: string
  sourceFlags: {
    hasBaseSystemPrompt: boolean
    hasGlobalCustomInstructions: boolean
    hasSkills: boolean
    hasProjectInstructions: boolean
    hasProjectKnowledge: boolean
    hasWorkingDirectoryHint: boolean
  }
  projectContextSummary?: string
}

export function buildCustomInstructionsSection(input: GlobalCustomInstructionsInput): string {
  if (!input.customInstructionsEnabled) {
    return ""
  }

  const parts: string[] = []
  if (input.aboutUser?.trim()) {
    parts.push(`[About the user]\n${input.aboutUser.trim()}`)
  }
  if (input.responsePreferences?.trim()) {
    parts.push(`[Response preferences]\n${input.responsePreferences.trim()}`)
  }
  if (input.customInstructions?.trim()) {
    parts.push(`[Additional instructions]\n${input.customInstructions.trim()}`)
  }

  return parts.join("\n\n").trim()
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`
}

function hashStablePayload(payload: unknown): string {
  const serialized = stableStringify(payload)
  let hash = 2166136261
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `ins_${(hash >>> 0).toString(16)}_${serialized.length}`
}

function buildSkillsSummary(skills: Skill[]): string {
  if (!skills.length) {
    return ""
  }
  return skills
    .map((skill) => {
      const name = skill.name || skill.id
      const description = skill.description
      return description ? `- ${name}: ${description}` : `- ${name}`
    })
    .join("\n")
}

export function buildExternalAgentInstructionStack(
  input: ExternalAgentInstructionStackInput
): ExternalAgentInstructionStackResult {
  const baseSystemPrompt = input.baseSystemPrompt?.trim() || "You are a helpful AI assistant."
  const customInstructionsSection = buildCustomInstructionsSection(input)

  const projectCustomInstructions = input.project?.customInstructions?.trim()
  let projectKnowledgePrompt = ""
  if (input.project && (input.project.knowledgeBase?.length ?? 0) > 0) {
    const projectContext = buildProjectContext(input.project, input.userQuery, {
      maxContextLength: 6000,
      useRelevanceFiltering: true,
    })
    projectKnowledgePrompt = projectContext.systemPrompt.trim()
  }

  const activeSkills = input.activeSkills || []
  const { prompt: skillsPrompt } = buildProgressiveSkillsPrompt(
    activeSkills,
    input.maxSkillsTokens || 4000
  )
  const skillsSummary = buildSkillsSummary(activeSkills)

  const sections: string[] = [baseSystemPrompt]
  if (customInstructionsSection) {
    sections.push(customInstructionsSection)
  }
  if (projectCustomInstructions) {
    sections.push(`[Project instructions]\n${projectCustomInstructions}`)
  }
  if (projectKnowledgePrompt) {
    sections.push(projectKnowledgePrompt)
  }
  if (skillsPrompt) {
    sections.unshift(skillsPrompt.trim())
  }

  const systemPrompt = sections
    .filter((section) => section.trim().length > 0)
    .join("\n\n")
    .trim()

  const developerSections: string[] = []
  if (customInstructionsSection) {
    developerSections.push(customInstructionsSection)
  }
  if (skillsSummary) {
    developerSections.push(`[Active skills]\n${skillsSummary}`)
  }
  if (projectCustomInstructions) {
    developerSections.push(`[Project instructions]\n${projectCustomInstructions}`)
  }
  if (projectKnowledgePrompt) {
    developerSections.push(
      `[Project knowledge context]\nUse the attached project context when it is relevant to the user request.`
    )
  }
  if (input.workingDirectory?.trim()) {
    developerSections.push(
      `[Workspace rules]\nWorking directory: ${input.workingDirectory.trim()}\nDiscover and obey workspace instructions (AGENTS) and local skills before making changes.`
    )
  }

  const developerInstructions = developerSections.join("\n\n").trim()

  const sourceFlags = {
    hasBaseSystemPrompt: !!baseSystemPrompt,
    hasGlobalCustomInstructions: !!customInstructionsSection,
    hasSkills: activeSkills.length > 0,
    hasProjectInstructions: !!projectCustomInstructions,
    hasProjectKnowledge: !!projectKnowledgePrompt,
    hasWorkingDirectoryHint: !!input.workingDirectory?.trim(),
  }

  const instructionHash = hashStablePayload({
    systemPrompt,
    developerInstructions,
    sourceFlags,
    workingDirectory: input.workingDirectory || "",
    activeSkills: activeSkills.map((skill) => ({
      id: skill.id,
      name: skill.name || "",
    })),
  })

  return {
    systemPrompt,
    instructionHash,
    developerInstructions,
    customInstructionsSection,
    skillsSummary,
    sourceFlags,
    projectContextSummary: projectKnowledgePrompt
      ? `project:${input.project?.id || "unknown"} knowledge:${input.project?.knowledgeBase?.length || 0}`
      : undefined,
  }
}
