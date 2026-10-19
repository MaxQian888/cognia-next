/**
 * Candidate harness validation (ADR-0237).
 *
 * Runs before any rollout. A candidate that fails is never executed: its
 * messages go back to the editor once, verbatim, and a second failure makes the
 * stage inherit its input harness (Harness²'s retry-once contract). Every
 * message names the file and the fix, because the editor reads them as
 * instructions.
 *
 * Beyond structure, this is where the safety boundary of the editable surface
 * is enforced: locked components cannot change, subagents cannot hold tools the
 * agent lacks, scripts with destructive shell commands are refused, and harness
 * text may not carry secrets or personal data.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { classifyCommand } from "@/lib/claude/permissions/command-safety"
import { validateSkill } from "@/lib/skills/validate"
import type {
  HarnessComponentName,
  HarnessComponentsV1,
  HarnessSkillV1,
} from "@/types/harness/snapshot"
import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"
import { MAX_TOOL_RULES } from "./tool-rules"
import { alwaysOnText, componentOfPath, componentsToTree, diffTrees } from "./tree"

/** Always-on text may reach this size whatever the base was. */
export const ALWAYS_ON_SOFT_CAP = 16_000
/** How much a candidate may grow the always-on text past a larger base. */
export const ALWAYS_ON_GROWTH = 3_000
export const MAX_SKILLS = 32
export const MAX_SKILL_CONTENT_BYTES = 64 * 1024
export const MAX_RESOURCE_BYTES = 64 * 1024
export const MAX_SUBAGENTS = 8
export const MAX_SUBAGENT_PROMPT_CHARS = 16_000
const SCRIPT_EXTENSIONS = new Set([".py", ".sh", ".bash", ".js", ".mjs", ".cjs", ".ts"])
const SHELL_EXTENSIONS = new Set([".sh", ".bash"])

export interface HarnessValidationPolicy {
  /** Components the editors may change. Every other component must stay byte-identical. */
  editable: readonly HarnessComponentName[]
  /**
   * The tools the agent's runs may use. Subagent tool lists must stay inside it.
   * Absent: the union of the base's subagent tools is the ceiling.
   */
  knownTools?: readonly string[]
}

export interface HarnessValidationReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  census: {
    alwaysOnChars: number
    skills: number
    scripts: number
    subagents: number
    toolRules: number
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot < 0 ? "" : path.slice(dot).toLowerCase()
}

/** Shell command strings embedded in a non-shell script: `os.system("…")`, `execSync('…')`, … */
const EMBEDDED_SHELL =
  /\b(?:os\.system|os\.popen|subprocess\.(?:run|call|check_call|check_output|Popen)|execSync|exec|spawnSync|spawn)\(\s*(?:\[\s*)?(["'`])([^"'`\n]{1,500})\1/g

function shellLines(path: string, content: string): string[] {
  if (SHELL_EXTENSIONS.has(extensionOf(path))) {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  }
  const out: string[] = []
  for (const match of content.matchAll(EMBEDDED_SHELL)) out.push(match[2])
  return out
}

function checkScript(skill: HarnessSkillV1, path: string, content: string, errors: string[]) {
  const where = `skills/${skill.key}/${path}`
  if (!SCRIPT_EXTENSIONS.has(extensionOf(path))) {
    errors.push(
      `${where}: scripts must be one of ${[...SCRIPT_EXTENSIONS].join(" ")}; ` +
        "put other helper files under references/"
    )
  }
  for (const line of shellLines(path, content)) {
    const verdict = classifyCommand(line)
    if (verdict.verdict === "deny") {
      errors.push(
        `${where}: refuses the command \`${line.slice(0, 120)}\` (${verdict.reason}); ` +
          "a harness helper must not run destructive or privileged commands"
      )
    }
  }
}

/** Script paths a body refers to, relative to the skill: `scripts/<file>`. */
const SCRIPT_REF = /(?:^|[\s`'"(=/])(scripts\/[A-Za-z0-9_][A-Za-z0-9_.-]*)/g
const QUALIFIED_SCRIPT_REF = /\bskills\/([a-z0-9-]+)\/(scripts\/[A-Za-z0-9_][A-Za-z0-9_.-]*)/g

function checkSkill(skill: HarnessSkillV1, errors: string[], warnings: string[]) {
  const where = `skills/${skill.key}/SKILL.md`
  for (const issue of validateSkill({
    name: skill.key,
    slug: skill.key,
    description: skill.description,
    content: skill.content,
    directoryName: skill.key,
    resources: skill.resources.map((r, index) => ({ id: `r${index}`, path: r.path })),
  })) {
    if (issue.severity === "runtime") errors.push(`${where}: ${issue.message}`)
    else if (issue.severity === "portability" && issue.field !== "name") {
      warnings.push(`${where}: ${issue.message}`)
    }
  }
  if (byteLength(skill.content) > MAX_SKILL_CONTENT_BYTES) {
    errors.push(`${where}: the body is over ${MAX_SKILL_CONTENT_BYTES} bytes; split it`)
  }
  const shipped = new Set(skill.resources.map((r) => r.path))
  for (const match of skill.content.matchAll(SCRIPT_REF)) {
    const ref = match[1]
    if (!shipped.has(ref)) {
      errors.push(
        `${where} invokes \`${ref}\` but skills/${skill.key}/${ref} is not in the harness; ` +
          "ship the helper with the skill or remove the reference"
      )
    }
  }
  for (const resource of skill.resources) {
    if ((resource.encoding ?? "utf-8") !== "utf-8") continue
    if (byteLength(resource.content) > MAX_RESOURCE_BYTES) {
      errors.push(
        `skills/${skill.key}/${resource.path}: over ${MAX_RESOURCE_BYTES} bytes; keep helpers small`
      )
    }
    if (resource.kind === "script") checkScript(skill, resource.path, resource.content, errors)
  }
}

function lockedChanges(
  candidate: HarnessComponentsV1,
  base: HarnessComponentsV1,
  editable: readonly HarnessComponentName[]
): string[] {
  const locked = new Set(HARNESS_COMPONENT_NAMES.filter((c) => !editable.includes(c)))
  if (locked.size === 0) return []
  const before = componentsToTree(base)
  const after = componentsToTree(candidate)
  const diff = diffTrees(before, after)
  const out: string[] = []
  for (const path of [...diff.added, ...diff.removed, ...diff.modified]) {
    const component = componentOfPath(path)
    if (component && locked.has(component)) {
      out.push(`${path}: the ${component} component is locked for this run; restore it unchanged`)
    }
  }
  return out
}

/** Validate a candidate against the harness it was edited from. */
export function validateHarnessCandidate(
  candidate: HarnessComponentsV1,
  base: HarnessComponentsV1,
  policy: HarnessValidationPolicy
): HarnessValidationReport {
  const errors: string[] = []
  const warnings: string[] = []

  errors.push(...lockedChanges(candidate, base, policy.editable))

  if (base.systemPrompt.trim() && !candidate.systemPrompt.trim()) {
    errors.push(
      "systemprompt.md is empty: it is the agent's persona and procedure, so trim it, never empty it"
    )
  }

  const always = alwaysOnText(candidate).length
  const baseAlways = alwaysOnText(base).length
  const cap = Math.max(ALWAYS_ON_SOFT_CAP, baseAlways + ALWAYS_ON_GROWTH)
  if (always > cap) {
    errors.push(
      `always-on text is ${always} chars, over the ${cap} limit for this harness; every always-on ` +
        "character is paid on every turn, so cut something to pay for what you add, or move it into a skill"
    )
  }

  if (candidate.skills.length > MAX_SKILLS) {
    errors.push(`${candidate.skills.length} skills; the limit is ${MAX_SKILLS}`)
  }
  const keys = new Set<string>()
  for (const skill of candidate.skills) {
    if (keys.has(skill.key)) errors.push(`skill \`${skill.key}\` is defined twice`)
    keys.add(skill.key)
    checkSkill(skill, errors, warnings)
  }

  const alwaysOn = alwaysOnText(candidate)
  for (const match of alwaysOn.matchAll(QUALIFIED_SCRIPT_REF)) {
    const skill = candidate.skills.find((s) => s.key === match[1])
    if (!skill || !skill.resources.some((r) => r.path === match[2])) {
      errors.push(
        `always-on text invokes \`skills/${match[1]}/${match[2]}\`, which is not in the harness`
      )
    }
  }

  if (candidate.subagents.length > MAX_SUBAGENTS) {
    errors.push(`${candidate.subagents.length} subagents; the limit is ${MAX_SUBAGENTS}`)
  }
  const ceiling = new Set(policy.knownTools ?? base.subagents.flatMap((s) => s.tools ?? []))
  const names = new Set<string>()
  for (const sub of candidate.subagents) {
    const where = `sub_agents/${sub.name}/AGENT.md`
    if (names.has(sub.name)) errors.push(`${where}: defined twice`)
    names.add(sub.name)
    if (sub.prompt.length > MAX_SUBAGENT_PROMPT_CHARS) {
      errors.push(`${where}: the prompt is over ${MAX_SUBAGENT_PROMPT_CHARS} chars`)
    }
    if (policy.knownTools || ceiling.size > 0) {
      const extra = (sub.tools ?? []).filter((t) => !ceiling.has(t))
      if (extra.length) {
        errors.push(
          `${where}: tools ${extra.join(", ")} are not available to this agent; ` +
            "a subagent may only use tools its parent already has"
        )
      }
    }
  }

  if (candidate.toolRules.length > MAX_TOOL_RULES) {
    errors.push(`${candidate.toolRules.length} tool rules; the limit is ${MAX_TOOL_RULES}`)
  }

  const texts: Array<[string, string]> = [
    ["systemprompt.md", candidate.systemPrompt],
    ["guardrails.md", candidate.guardrails],
    ["memory.md", candidate.memory],
    ["tool_guidance.md", candidate.toolGuidance],
    ...candidate.skills.flatMap((s): Array<[string, string]> => [
      [`skills/${s.key}/SKILL.md`, `${s.description}\n${s.content}`],
      ...s.resources
        .filter((r) => (r.encoding ?? "utf-8") === "utf-8")
        .map((r): [string, string] => [`skills/${s.key}/${r.path}`, r.content]),
    ]),
    ...candidate.subagents.map((s): [string, string] => [
      `sub_agents/${s.name}/AGENT.md`,
      `${s.description}\n${s.prompt}`,
    ]),
  ]
  const baseTexts = new Map(
    [
      ["systemprompt.md", base.systemPrompt],
      ["guardrails.md", base.guardrails],
      ["memory.md", base.memory],
      ["tool_guidance.md", base.toolGuidance],
    ].map(([k, v]) => [k, v])
  )
  for (const [path, body] of texts) {
    // A base the person wrote is not this run's problem; only new text is gated.
    if (baseTexts.get(path) === body) continue
    if (!hasNoLeakingPii(body)) {
      errors.push(
        `${path}: contains something that looks like a credential or personal data; ` +
          "harness text is stored and shared with later runs, so remove it"
      )
    }
  }

  const scripts = candidate.skills.reduce(
    (n, s) => n + s.resources.filter((r) => r.kind === "script").length,
    0
  )
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    census: {
      alwaysOnChars: always,
      skills: candidate.skills.length,
      scripts,
      subagents: candidate.subagents.length,
      toolRules: candidate.toolRules.length,
    },
  }
}
