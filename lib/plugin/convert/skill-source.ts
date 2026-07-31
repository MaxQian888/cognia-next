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
 * - **Sibling `scripts/` / `references/` / `assets/`** → `local-bundle`,
 *   with the whole folder copied under `skills/<id>/` inside the plugin.
 *   That path is plugin-dir-relative and is anchored at registration time
 *   by `rebaseSkillSource`. Bundle skills are desktop-only: their body is
 *   read through `@tauri-apps/plugin-fs`.
 */

import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { slugify } from "./identity"
import type { ConvertCandidate } from "./types"

/** Directory names whose presence means the skill carries resources. */
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

/** True when a relative resource path belongs to a recognised bundle dir. */
export function isBundleResource(relativePath: string): boolean {
  const head = relativePath.replace(/^[./\\]+/, "").split(/[\\/]/)[0]
  return (BUNDLE_RESOURCE_DIRS as readonly string[]).includes(head)
}

export interface BuiltSkill {
  skill: PluginSkillDef
  /** True when the generated source reads from disk (desktop-only). */
  needsFilesystem: boolean
  /** Files to copy into the plugin, relative to the source folder. */
  copies: Array<{ from: string; to: string }>
  warnings: string[]
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

  const bundled = resources.filter(isBundleResource)
  const ignored = resources.filter((r) => !isBundleResource(r) && !/^SKILL\.md$/i.test(r))
  const allWarnings = [...warnings]
  for (const path of ignored) {
    allWarnings.push(
      `"${path}" is not under ${BUNDLE_RESOURCE_DIRS.join("/")} and was not copied into the plugin`
    )
  }

  if (bundled.length === 0) {
    return {
      skill: {
        id,
        name: draft.name,
        description: draft.description ?? "",
        source: { kind: "inline", markdown: draft.content },
        ...(draft.allowedTools?.length ? { allowedTools: [...draft.allowedTools] } : {}),
      },
      needsFilesystem: false,
      copies: [],
      warnings: allWarnings,
    }
  }

  const bundleDir = `${SKILL_BUNDLE_DIR}/${id}`
  return {
    skill: {
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
  }
}
