// Compose the SKILL.md frontmatter parser (`lib/claude/skills-io`) with the
// optional `agents/openai.yaml` parser into a single "parse this bundle's
// manifest layer" entry point. The bundle loader (`loader.ts`) does the file
// walking; this module owns the conversion from "two text blobs" to "a
// SkillDraft plus typed Codex metadata".
//
// Fatal-vs-non-fatal split mirrors `lib/skills/marketplace-install.ts`:
// `missing-name` / `missing-content` throw so the import dialog refuses
// loudly; everything else lives on the draft as a warning.

import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import { validateSkill } from "@/lib/skills/validate"
import type { SkillDraft } from "@/lib/db/skills"
import type { SkillValidationError } from "@/lib/claude/types"
import { parseCodexOpenaiYaml, type CodexOpenaiMeta } from "./codex-yaml"

export type BundleFlavor = "anthropic" | "codex"

export interface BundleManifestParseInput {
  /** Required — body of `SKILL.md`. */
  skillMd: string
  /** Optional — body of `agents/openai.yaml`. Presence flips flavor → "codex". */
  openaiYaml?: string
  /** Used by `parseSkillMarkdown` when the frontmatter omits `name`. */
  fallbackName?: string
}

export interface BundleManifestParseResult {
  draft: SkillDraft
  flavor: BundleFlavor
  codexMeta?: CodexOpenaiMeta
  /** Non-fatal validator findings stored on the resulting skill row. */
  nonFatalValidationErrors: SkillValidationError[]
  /** Soft warnings from the markdown / yaml parsers + drift folding. */
  warnings: string[]
}

const FATAL_VALIDATION_CODES = new Set<SkillValidationError["code"]>([
  "missing-name",
  "missing-content",
])

/**
 * Parse the manifest layer (SKILL.md + optional Codex openai.yaml) of a
 * skill bundle. Throws on fatal validation issues; returns the draft plus
 * accumulated warnings otherwise.
 *
 * The Codex meta is folded into the draft when present:
 *   - `interface.display_name` → if the SKILL.md frontmatter omitted
 *     `name`, the Codex display name wins over the filename fallback.
 *   - `dependencies.tools[]` with `type === "mcp"` → MCP tool ids get
 *     surfaced as warnings (we don't auto-attach MCP servers; the user
 *     wires those in the marketplace).
 *   - `policy.allow_implicit_invocation === false` → warning that the
 *     skill is opt-in only; the runtime invocation policy lives elsewhere.
 */
export function parseBundleManifest(input: BundleManifestParseInput): BundleManifestParseResult {
  const warnings: string[] = []

  const skillMdParse = parseSkillMarkdown(input.skillMd, {
    fallbackName: input.fallbackName,
  })
  warnings.push(...skillMdParse.warnings)
  let draft: SkillDraft = skillMdParse.draft

  let flavor: BundleFlavor = "anthropic"
  let codexMeta: CodexOpenaiMeta | undefined

  if (input.openaiYaml !== undefined) {
    flavor = "codex"
    codexMeta = parseCodexOpenaiYaml(input.openaiYaml)
    warnings.push(...codexMeta.warnings)

    // Display-name precedence: SKILL.md frontmatter > Codex interface >
    // filename fallback. We only override when the markdown name equals
    // the supplied fallback, signalling the user didn't set one.
    const codexDisplay = codexMeta.interface?.displayName
    if (codexDisplay && input.fallbackName && draft.name === input.fallbackName) {
      draft = { ...draft, name: codexDisplay }
    }

    if (codexMeta.policy?.allowImplicitInvocation === false) {
      warnings.push(
        "agents/openai.yaml policy disables implicit invocation — the skill will only run when the user calls it explicitly."
      )
    }

    if (codexMeta.toolDependencies.length > 0) {
      const mcpIds = codexMeta.toolDependencies
        .filter((t) => t.type === "mcp")
        .map((t) => t.value)
        .filter((v): v is string => typeof v === "string")
      if (mcpIds.length > 0) {
        warnings.push(
          `agents/openai.yaml declares MCP dependencies (${mcpIds.join(
            ", "
          )}). Install them from the Marketplace separately; the bundle import does not auto-wire MCP servers.`
        )
      }
    }
  }

  const validationErrors = validateSkill({
    name: draft.name,
    description: draft.description,
    content: draft.content,
  })
  const fatal = validationErrors.find((e) => FATAL_VALIDATION_CODES.has(e.code))
  if (fatal) {
    throw new Error(`Skill bundle refused: ${fatal.message}`)
  }
  const nonFatal = validationErrors.filter((e) => !FATAL_VALIDATION_CODES.has(e.code))

  return {
    draft,
    flavor,
    codexMeta,
    nonFatalValidationErrors: nonFatal,
    warnings,
  }
}
