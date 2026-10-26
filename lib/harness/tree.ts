/**
 * The editable harness tree (ADR-0237).
 *
 * Editors read and change a harness as files, the way Harness² serves it: the
 * evidence is on disk and the edited tree comes back. This module is the pure
 * projection between {@link HarnessComponentsV1} and that tree.
 *
 *   systemprompt.md                 persona and procedure        (always on)
 *   guardrails.md                   standing rules               (always on)
 *   memory.md                       durable domain facts         (always on)
 *   tool_guidance.md                how to use the tools         (always on)
 *   skills/<key>/SKILL.md           an on-demand workflow
 *   skills/<key>/scripts/<file>     a helper carried by the skill
 *   skills/<key>/references/<file>  reference text carried by the skill
 *   sub_agents/<name>/AGENT.md      a delegated subagent
 *   tool_rules.json                 declarative tool-loop rules
 *
 * The edit contract is omitted-is-removed for skills and subagents (deleting a
 * file removes the component) and present-is-kept for the always-on files (an
 * absent file reads as empty text). SKILL.md and AGENT.md reuse the app's own
 * serializers so a harness skill is the same file a person can export.
 */

import { computeDiff } from "@/lib/artifacts/diff"
import { parseSkillMarkdown, serializeSkill } from "@/lib/claude/skills-io"
import { parseMarkdownAgent, serializeMarkdownAgent } from "@/lib/claude/agents/markdown-agents"
import { isValidSkillSlug } from "@/lib/skills/slug"
import type {
  HarnessComponentName,
  HarnessComponentsV1,
  HarnessSkillResourceKind,
  HarnessSkillResourceV1,
  HarnessSkillV1,
} from "@/types/harness/snapshot"
import type {
  HarnessSubagentDefinition,
  HarnessToolRule,
} from "@cognia/agent-config-types/agent-harness"
import { HARNESS_TOOL_RULES_VERSION } from "@cognia/agent-config-types/agent-harness"
import { parseHarnessToolRules } from "./tool-rules"

/** Path → UTF-8 content. */
export type HarnessTree = Record<string, string>

export const HARNESS_PATHS = {
  systemPrompt: "systemprompt.md",
  guardrails: "guardrails.md",
  memory: "memory.md",
  toolGuidance: "tool_guidance.md",
  toolRules: "tool_rules.json",
} as const

/** The always-on files, in the order they are rendered into a run's context. */
export const ALWAYS_ON_PATHS = [
  HARNESS_PATHS.systemPrompt,
  HARNESS_PATHS.guardrails,
  HARNESS_PATHS.memory,
  HARNESS_PATHS.toolGuidance,
] as const

const RESOURCE_DIRS: Record<string, HarnessSkillResourceKind> = {
  scripts: "script",
  references: "reference",
  assets: "asset",
}

const KIND_DIRS: Record<HarnessSkillResourceKind, string> = {
  script: "scripts",
  reference: "references",
  asset: "assets",
}

const SUBAGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESOURCE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const SKILL_FILE = /^skills\/([^/]+)\/SKILL\.md$/
const SKILL_RESOURCE = /^skills\/([^/]+)\/(scripts|references|assets)\/([^/]+)$/
const SUBAGENT_FILE = /^sub_agents\/([^/]+)\/AGENT\.md$/

/**
 * Normalise a relative path, refusing anything that would escape the tree.
 * Throws so callers cannot accidentally join an absolute or `..` path.
 */
export function normalizeHarnessPath(rel: string): string {
  let r = String(rel).trim().replace(/\\/g, "/")
  if (r.startsWith("/") || /^[A-Za-z]:\//.test(r) || r.split("/").includes("..")) {
    throw new Error(`path escapes the harness: ${JSON.stringify(rel)}`)
  }
  while (r.startsWith("./")) r = r.slice(2)
  return r.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "")
}

/** Which component a tree path belongs to, or `null` when it is off the surface. Never throws. */
export function componentOfPath(rel: string): HarnessComponentName | null {
  let r: string
  try {
    r = normalizeHarnessPath(rel)
  } catch {
    return null
  }
  switch (r) {
    case HARNESS_PATHS.systemPrompt:
      return "systemPrompt"
    case HARNESS_PATHS.guardrails:
      return "guardrails"
    case HARNESS_PATHS.memory:
      return "memory"
    case HARNESS_PATHS.toolGuidance:
      return "toolGuidance"
    case HARNESS_PATHS.toolRules:
      return "toolRules"
  }
  const skill = SKILL_FILE.exec(r)
  if (skill) return isValidSkillSlug(skill[1]) ? "skills" : null
  const resource = SKILL_RESOURCE.exec(r)
  if (resource) {
    if (!isValidSkillSlug(resource[1]) || !RESOURCE_FILE.test(resource[3])) return null
    return resource[2] === "scripts" ? "scripts" : "skills"
  }
  const sub = SUBAGENT_FILE.exec(r)
  if (sub) return SUBAGENT_NAME.test(sub[1]) ? "subagents" : null
  return null
}

/** Whether this path is on the editable surface. A predicate: it never throws. */
export function isHarnessPath(rel: string): boolean {
  return componentOfPath(rel) !== null
}

function skillMarkdown(skill: HarnessSkillV1): string {
  return serializeSkill({
    name: skill.name,
    slug: skill.key,
    description: skill.description,
    content: skill.content,
    allowedTools: skill.allowedTools,
  })
}

function subagentMarkdown(sub: HarnessSubagentDefinition): string {
  return serializeMarkdownAgent(sub.name, {
    description: sub.description,
    prompt: sub.prompt,
    ...(sub.tools?.length ? { tools: sub.tools } : {}),
  })
}

function toolRulesJson(rules: HarnessToolRule[]): string {
  return `${JSON.stringify({ version: HARNESS_TOOL_RULES_VERSION, rules }, null, 2)}\n`
}

/**
 * Project components to the editable tree. Binary (base64) skill resources are
 * not editable and stay out of the tree; {@link treeToComponents} carries them
 * over from the previous components unchanged.
 */
export function componentsToTree(components: HarnessComponentsV1): HarnessTree {
  const tree: HarnessTree = {
    [HARNESS_PATHS.systemPrompt]: components.systemPrompt,
    [HARNESS_PATHS.guardrails]: components.guardrails,
    [HARNESS_PATHS.memory]: components.memory,
    [HARNESS_PATHS.toolGuidance]: components.toolGuidance,
  }
  for (const skill of components.skills) {
    tree[`skills/${skill.key}/SKILL.md`] = skillMarkdown(skill)
    for (const resource of skill.resources) {
      if ((resource.encoding ?? "utf-8") !== "utf-8") continue
      const fileName = resource.path.split("/").pop() ?? resource.path
      tree[`skills/${skill.key}/${KIND_DIRS[resource.kind]}/${fileName}`] = resource.content
    }
  }
  for (const sub of components.subagents) {
    tree[`sub_agents/${sub.name}/AGENT.md`] = subagentMarkdown(sub)
  }
  if (components.toolRules.length > 0) {
    tree[HARNESS_PATHS.toolRules] = toolRulesJson(components.toolRules)
  }
  return tree
}

export interface TreeParseResult {
  components: HarnessComponentsV1
  /** Problems a person (or the editor, on retry) can act on. Empty when the tree parsed cleanly. */
  errors: string[]
  /** Paths present in the input that are off the editable surface. */
  rejectedPaths: string[]
}

function parseSkillFile(
  key: string,
  text: string,
  errors: string[]
): Omit<HarnessSkillV1, "resources" | "sourceSkillId" | "sourceHash"> | null {
  const path = `skills/${key}/SKILL.md`
  try {
    const { draft } = parseSkillMarkdown(text, { fallbackName: key })
    if (draft.slug !== key) {
      errors.push(
        `${path}: frontmatter \`name: ${draft.slug}\` must equal the directory name \`${key}\``
      )
    }
    if (!draft.description?.trim()) {
      errors.push(`${path}: frontmatter needs a non-empty \`description:\``)
    }
    return {
      key,
      name: draft.name?.trim() || key,
      description: draft.description?.trim() ?? "",
      content: draft.content,
      ...(draft.allowedTools?.length ? { allowedTools: draft.allowedTools } : {}),
    }
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function parseSubagentFile(
  name: string,
  text: string,
  errors: string[]
): HarnessSubagentDefinition | null {
  const path = `sub_agents/${name}/AGENT.md`
  const parsed = parseMarkdownAgent(name, text)
  if ("error" in parsed) {
    errors.push(`${path}: ${parsed.error}`)
    return null
  }
  const def = parsed.def
  // Execution settings are locked: a subagent may not pick its own model,
  // provider, turn budget or effort, and may only narrow tools.
  for (const field of ["model", "provider", "maxTurns", "effort"] as const) {
    if (def[field] !== undefined) {
      errors.push(`${path}: \`${field}\` is not editable; remove it from the frontmatter`)
    }
  }
  return {
    name,
    description: def.description,
    prompt: def.prompt,
    ...(def.tools?.length ? { tools: def.tools } : {}),
  }
}

/**
 * Parse an edited tree back into components. Never throws on content: every
 * problem is collected so it can be fed back to the editor verbatim.
 */
export function treeToComponents(
  input: HarnessTree,
  previous?: HarnessComponentsV1
): TreeParseResult {
  const errors: string[] = []
  const rejectedPaths: string[] = []
  const tree: HarnessTree = {}
  for (const [rel, content] of Object.entries(input)) {
    let normalized: string
    try {
      normalized = normalizeHarnessPath(rel)
    } catch {
      rejectedPaths.push(rel)
      continue
    }
    if (!isHarnessPath(normalized)) {
      rejectedPaths.push(rel)
      continue
    }
    tree[normalized] = content
  }

  const skills = new Map<string, HarnessSkillV1>()
  const orphanResources = new Map<string, string[]>()
  const subagents: HarnessSubagentDefinition[] = []
  let toolRules: HarnessToolRule[] = []

  for (const rel of Object.keys(tree).sort()) {
    const skill = SKILL_FILE.exec(rel)
    if (skill) {
      const parsed = parseSkillFile(skill[1], tree[rel], errors)
      if (parsed) skills.set(skill[1], { ...parsed, resources: [] })
      continue
    }
    const sub = SUBAGENT_FILE.exec(rel)
    if (sub) {
      const parsed = parseSubagentFile(sub[1], tree[rel], errors)
      if (parsed) subagents.push(parsed)
      continue
    }
    if (rel === HARNESS_PATHS.toolRules) {
      const parsed = parseHarnessToolRules(tree[rel])
      if (parsed.ok) toolRules = parsed.rules
      else errors.push(...parsed.errors.map((e) => `${HARNESS_PATHS.toolRules}: ${e}`))
    }
  }

  for (const rel of Object.keys(tree).sort()) {
    const resource = SKILL_RESOURCE.exec(rel)
    if (!resource) continue
    const owner = skills.get(resource[1])
    if (!owner) {
      const list = orphanResources.get(resource[1]) ?? []
      list.push(rel)
      orphanResources.set(resource[1], list)
      continue
    }
    owner.resources.push({
      path: `${resource[2]}/${resource[3]}`,
      kind: RESOURCE_DIRS[resource[2]],
      content: tree[rel],
      encoding: "utf-8",
    })
  }
  for (const [key, paths] of orphanResources) {
    errors.push(
      `${paths.join(", ")} belong to skill \`${key}\`, which has no skills/${key}/SKILL.md; ` +
        "a helper must travel with the skill that uses it"
    )
  }

  // Carry binary resources (never on the editable surface) over by skill key.
  const previousSkills = new Map((previous?.skills ?? []).map((s) => [s.key, s]))
  for (const [key, skill] of skills) {
    const prior = previousSkills.get(key)
    if (!prior) continue
    for (const resource of prior.resources) {
      if ((resource.encoding ?? "utf-8") === "utf-8") continue
      skill.resources.push({ ...resource })
    }
    if (prior.sourceSkillId) skill.sourceSkillId = prior.sourceSkillId
    if (prior.sourceHash) skill.sourceHash = prior.sourceHash
  }

  return {
    components: {
      systemPrompt: tree[HARNESS_PATHS.systemPrompt] ?? "",
      guardrails: tree[HARNESS_PATHS.guardrails] ?? "",
      memory: tree[HARNESS_PATHS.memory] ?? "",
      toolGuidance: tree[HARNESS_PATHS.toolGuidance] ?? "",
      skills: [...skills.values()].sort((a, b) => a.key.localeCompare(b.key)),
      subagents: subagents.sort((a, b) => a.name.localeCompare(b.name)),
      toolRules,
    },
    errors,
    rejectedPaths: rejectedPaths.sort(),
  }
}

/** The always-on text a run pays for on every turn. */
export function alwaysOnText(components: HarnessComponentsV1): string {
  return [
    components.systemPrompt,
    components.guardrails,
    components.memory,
    components.toolGuidance,
  ].join("\n\n")
}

export interface TreeDiffSummary {
  added: string[]
  removed: string[]
  modified: string[]
}

/** Path-level difference between two trees. */
export function diffTrees(before: HarnessTree, after: HarnessTree): TreeDiffSummary {
  const added = Object.keys(after)
    .filter((p) => !(p in before))
    .sort()
  const removed = Object.keys(before)
    .filter((p) => !(p in after))
    .sort()
  const modified = Object.keys(after)
    .filter((p) => p in before && before[p] !== after[p])
    .sort()
  return { added, removed, modified }
}

/** True when the two trees carry the same files with the same content. */
export function treesEqual(a: HarnessTree, b: HarnessTree): boolean {
  const d = diffTrees(a, b)
  return d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0
}

/**
 * A unified diff of two trees, `---`/`+++` per changed file, with three lines of
 * context around each change. Used for the editor's candidate pool and for people.
 */
export function unifiedTreeDiff(
  before: HarnessTree,
  after: HarnessTree,
  labels: { from: string; to: string } = { from: "current", to: "candidate" },
  context = 3
): string {
  const out: string[] = []
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const path of paths) {
    const a = before[path] ?? ""
    const b = after[path] ?? ""
    if (a === b && path in before === path in after) continue
    const lines = computeDiff(a, b)
    const changed = lines.map((l) => l.type !== "unchanged")
    const keep = lines.map((_, i) => {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
        if (changed[j]) return true
      }
      return false
    })
    out.push(`--- ${path in before ? `${labels.from}/${path}` : "/dev/null"}`)
    out.push(`+++ ${path in after ? `${labels.to}/${path}` : "/dev/null"}`)
    let skipping = false
    lines.forEach((line, i) => {
      if (!keep[i]) {
        if (!skipping) out.push("@@ … @@")
        skipping = true
        return
      }
      skipping = false
      const mark = line.type === "added" ? "+" : line.type === "removed" ? "-" : " "
      out.push(`${mark}${line.content}`)
    })
  }
  return out.length ? `${out.join("\n")}\n` : ""
}

export interface TreeDiversity {
  n: number
  nDistinct: number
  /** Mean pairwise Jaccard similarity over non-empty `path:line` sets; 1 means identical. */
  meanLineJaccard: number
}

/** How different a set of candidate trees are, so a collapse to one body is visible. */
export function treeDiversity(trees: Record<string, HarnessTree>): TreeDiversity {
  const names = Object.keys(trees).sort()
  const signature = (t: HarnessTree) =>
    JSON.stringify(
      Object.keys(t)
        .sort()
        .map((k) => [k, t[k]])
    )
  const nDistinct = new Set(names.map((n) => signature(trees[n]))).size
  if (names.length < 2) return { n: names.length, nDistinct, meanLineJaccard: 1 }
  const sets = new Map(
    names.map((n) => [
      n,
      new Set(
        Object.entries(trees[n]).flatMap(([path, body]) =>
          body
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => `${path}:${line}`)
        )
      ),
    ])
  )
  const sims: number[] = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = sets.get(names[i])!
      const b = sets.get(names[j])!
      let inter = 0
      for (const x of a) if (b.has(x)) inter++
      const union = a.size + b.size - inter
      sims.push(union === 0 ? 1 : inter / union)
    }
  }
  const mean = sims.reduce((s, v) => s + v, 0) / sims.length
  return { n: names.length, nDistinct, meanLineJaccard: Math.round(mean * 10_000) / 10_000 }
}

/** A one-line census of the components in a harness, for indexes and run cards. */
export function harnessInventory(components: HarnessComponentsV1): string {
  const scripts = components.skills.reduce(
    (n, s) => n + s.resources.filter((r) => r.kind === "script").length,
    0
  )
  const bits = [
    components.skills.length ? `${components.skills.length} skills` : "",
    scripts ? `${scripts} scripts` : "",
    components.subagents.length ? `${components.subagents.length} subagents` : "",
    components.toolRules.length ? `${components.toolRules.length} tool rules` : "",
  ].filter(Boolean)
  const always = alwaysOnText(components).length
  return `${bits.length ? bits.join(", ") : "always-on text only"}; ${always.toLocaleString("en-US")} always-on chars`
}

/** Look up one resource by its tree path inside a skill. */
export function findSkillResource(
  skill: HarnessSkillV1,
  path: string
): HarnessSkillResourceV1 | undefined {
  return skill.resources.find((r) => r.path === path)
}
