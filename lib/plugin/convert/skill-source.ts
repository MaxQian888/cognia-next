/**
 * Turn a SKILL.md folder into a `PluginSkillDef`.
 *
 * Frontmatter parsing is delegated to `parseSkillMarkdown`
 * (`lib/claude/skills-io.ts`), the same parser the chat-import path and the
 * bundle loader use, so a skill that imports into a chat converts to a
 * plugin with identical name / description / body semantics.
 *
 * Source-kind selection is driven by content, not by flag:
 *
 * - **No sibling resources** → `inline`. The body lives in the manifest and
 *   resolves in every shell (desktop, browser, mobile), because
 *   `resolveSkillMarkdown` returns inline markdown without touching a
 *   filesystem.
 * - **Sibling resources** → `local-bundle`,
 *   with the whole folder copied under `skills/<id>/` inside the plugin.
 *   That path is plugin-dir-relative and is anchored at registration time
 *   by `rebaseSkillSource`. Bundle skills are desktop-only: their body is
 *   read through `@tauri-apps/plugin-fs`.
 */

import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { slugify } from "./identity"
import type { ConvertCandidate } from "./types"

/** Conventional resource folders; other safe sibling paths are preserved too. */
export const BUNDLE_RESOURCE_DIRS = ["scripts", "references", "assets"] as const

/** Folder the converter copies a resource-bearing skill into. */
export const SKILL_BUNDLE_DIR = "skills"

/** A skill folder has exactly one convertible thing in it. */
export function listSkillCandidates(text: string, sourceName?: string): ConvertCandidate[] {
  const { draft } = parseSkillMarkdown(text, { fallbackName: sourceName })
  return [
    {
      id: slugify(draft.name),
      label: draft.name,
      detail: draft.description ?? "SKILL.md",
    },
  ]
}

/** True for safe relative sibling files, excluding the skill entrypoint. */
export function isBundleResource(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
  return (
    Boolean(path) &&
    !path.startsWith("/") &&
    !/^[a-z]:/i.test(path) &&
    !/[\x00-\x1f]/.test(path) &&
    !path.split("/").some((part) => part === ".." || part === "." || part === "") &&
    !/^SKILL\.md$/i.test(path)
  )
}

/** Execution semantics Cognia does not implement by retaining Markdown. */
export const UNSUPPORTED_SKILL_EXECUTION_FIELDS = [
  "context",
  "agent",
  "model",
  "hooks",
  "user-invocable",
  "paths",
  "priority",
  "sessionStart",
  "pathPatterns",
  "bashPatterns",
  "importPatterns",
  "promptSignals",
] as const

export interface BuiltSkill {
  skill: PluginSkillDef
  /** True when the generated source reads from disk (desktop-only). */
  needsFilesystem: boolean
  /** Files to copy into the plugin, relative to the source folder. */
  copies: Array<{ from: string; to: string }>
  warnings: string[]
  blockers: string[]
}

/**
 * Build the skill def for a folder.
 *
 * @param text        SKILL.md contents.
 * @param resources   Sibling files relative to the skill folder.
 * @param sourceName  Folder basename, used when frontmatter omits `name`.
 */
export function buildSkill(
  text: string,
  resources: string[] = [],
  sourceName?: string
): BuiltSkill {
  const { draft, warnings } = parseSkillMarkdown(text, { fallbackName: sourceName })
  const id = slugify(draft.name)
  if (!id) throw new Error(`cannot derive a skill id from name "${draft.name}"`)

  const bundled: string[] = []
  for (const resource of resources) {
    const path = resource.replace(/\\/g, "/").replace(/^\.\//, "")
    if (/^SKILL\.md$/i.test(path)) continue
    if (!isBundleResource(path)) throw new Error(`unsafe resource path "${resource}"`)
    if (!bundled.includes(path)) bundled.push(path)
  }
  const allWarnings = [...warnings]
  const blockers = UNSUPPORTED_SKILL_EXECUTION_FIELDS.filter((field) =>
    Object.hasOwn(draft.frontmatterExtensions ?? {}, field)
  ).map(
    (field) =>
      `Skill "${id}" requires unsupported execution field "${field}"; preserving its text does not implement its behavior.`
  )
  if (/!`[^`]+`/.test(draft.content)) {
    blockers.push(
      `Skill "${id}" requires shell preprocessing (! followed by a backtick command), which Cognia does not execute.`
    )
  }
  if (
    /\$(?:ARGUMENTS(?:\[\d+\])?|\d+)|\$\{(?:CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR)\}/.test(
      draft.content
    )
  ) {
    blockers.push(
      `Skill "${id}" requires invocation argument or session substitutions which Cognia does not implement.`
    )
  }
  const metadata: Partial<PluginSkillDef> = {}
  for (const field of [
    "slug",
    "compatibility",
    "metadata",
    "frontmatterExtensions",
    "invocationPolicy",
    "license",
    "version",
    "author",
    "tags",
    "category",
  ] as const) {
    if (draft[field] !== undefined) Object.assign(metadata, { [field]: draft[field] })
  }

  if (bundled.length === 0) {
    return {
      skill: {
        ...metadata,
        id,
        name: draft.name,
        description: draft.description ?? "",
        source: { kind: "inline", markdown: draft.content },
        ...(draft.allowedTools?.length ? { allowedTools: [...draft.allowedTools] } : {}),
      },
      needsFilesystem: false,
      copies: [],
      warnings: allWarnings,
      blockers,
    }
  }

  const bundleDir = `${SKILL_BUNDLE_DIR}/${id}`
  return {
    skill: {
      ...metadata,
      id,
      name: draft.name,
      description: draft.description ?? "",
      source: { kind: "local-bundle", path: bundleDir },
      ...(draft.allowedTools?.length ? { allowedTools: [...draft.allowedTools] } : {}),
    },
    needsFilesystem: true,
    copies: [
      { from: "SKILL.md", to: `${bundleDir}/SKILL.md` },
      ...bundled.map((path) => ({ from: path, to: `${bundleDir}/${path}` })),
    ],
    warnings: allWarnings,
    blockers,
  }
}
