// OpenCode agent adapter.
//
// Source files: `~/.config/opencode/agents/<name>.md` (global) and
// `<project>/.opencode/agents/<name>.md` (project). The singular legacy
// directory remains recognized so older installations can still migrate.
//
// Frontmatter shape:
//   ---
//   description: Reviews code for quality and correctness.
//   mode: subagent                    # primary | subagent | all
//   model: anthropic/claude-sonnet-4  # "<provider>/<model>"
//   temperature: 0.1
//   tools:                            # a MAP of tool → enabled, not a list
//     write: false
//     edit: false
//     bash: true
//   permission:                       # OpenCode's own allow/ask/deny ruleset
//     edit: deny
//   ---
//   System prompt body...
//
// Three shape differences from every other adapter in this folder, and they
// are the whole reason this file exists rather than reusing `generic-md`:
//   1. There is NO `name` key — the filename IS the agent name.
//   2. `tools` is a map, so `parseList` would drop it silently. We keep only
//      the enabled keys (a disabled tool is an absence, not a selection).
//   3. `model` is namespaced `provider/model`, which also gives us the
//      provider hint for free.
//
// `mode: primary` agents are top-level personas rather than delegates; they
// still import (the user asked for them), but carry a warning so the mismatch
// is visible instead of silent — see Working Rule 7.

import type { ImportInput, ParseResult, SubagentImportDraft, SubagentSourceAdapter } from "./types"
import {
  buildDraft,
  ensureMinimum,
  fileMatchesAnyExt,
  nameFromFilename,
  parseFrontmatter,
  stringOrUndef,
} from "./_parse-helpers"

const ACCEPTED = [".md", ".markdown"]
/** Current plural layout plus the pre-1.x singular layout. */
const PATH_HINTS = ["opencode/agent/", "opencode/agents/"]

/** Provider prefixes OpenCode uses, mapped to our coarse hint. */
const PROVIDER_HINTS: Record<string, SubagentImportDraft["providerHint"]> = {
  anthropic: "anthropic",
  openai: "openai",
  azure: "openai",
  "github-copilot": "openai",
  google: "gemini",
  "google-vertex": "gemini",
  gemini: "gemini",
}

/** Whether a path looks like it came out of an OpenCode agent directory. */
export function looksLikeOpencodeAgentPath(sourcePath: string): boolean {
  const p = sourcePath.replace(/\\/g, "/").toLowerCase()
  return PATH_HINTS.some((hint) => p.includes(hint))
}

/**
 * OpenCode's `tools:` map → the enabled tool names. `{ write: false }` means
 * "deny write", which is the absence of a selection, not a selection of
 * nothing — so disabled entries are dropped rather than imported as tools.
 * Returns undefined when nothing is enabled (or the value isn't a map), which
 * keeps `SubagentImportDraft.tools` meaning "inherit everything".
 */
export function enabledToolsFromMap(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const enabled = Object.entries(value as Record<string, unknown>)
    .filter(([, on]) => on === true)
    .map(([tool]) => tool.trim())
    .filter(Boolean)
  return enabled.length > 0 ? enabled : undefined
}

/** Split `anthropic/claude-sonnet-4` into a provider hint + the bare model id. */
export function splitNamespacedModel(model: string | undefined): {
  model?: string
  providerHint?: SubagentImportDraft["providerHint"]
} {
  if (!model) return {}
  const slash = model.indexOf("/")
  if (slash <= 0) return { model }
  const provider = model.slice(0, slash).toLowerCase()
  const bare = model.slice(slash + 1).trim()
  const hint = PROVIDER_HINTS[provider]
  // Keep the full namespaced id when we don't recognize the provider — a
  // half-parsed model id is worse than an opaque one.
  return hint ? { model: bare || model, providerHint: hint } : { model }
}

export const opencodeAdapter: SubagentSourceAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  labelKey: "opencode",
  acceptedExtensions: ACCEPTED,

  detect(input) {
    const accepted = input.files.filter((f) => fileMatchesAnyExt(f.filename, ACCEPTED))
    if (accepted.length === 0) return "no"
    const hits = accepted.filter((f) => looksLikeOpencodeAgentPath(f.sourcePath))
    if (hits.length > 0) return hits.length === input.files.length ? "match" : "maybe"
    // No path hint (pasted text / flat picker): fall back to the frontmatter
    // fingerprint — `mode:` plus a name-less header is OpenCode-shaped.
    const fingerprinted = accepted.some((f) => {
      try {
        const fm = parseFrontmatter(f.content).data
        const mode = stringOrUndef(fm.mode)
        const hasMode = mode === "subagent" || mode === "primary" || mode === "all"
        const toolsIsMap = !!fm.tools && typeof fm.tools === "object" && !Array.isArray(fm.tools)
        return (hasMode || toolsIsMap) && !stringOrUndef(fm.name)
      } catch {
        return false
      }
    })
    return fingerprinted ? "maybe" : "no"
  },

  parse(input: ImportInput): ParseResult {
    const drafts: SubagentImportDraft[] = []
    const errors: ParseResult["errors"] = []

    for (const file of input.files) {
      if (!fileMatchesAnyExt(file.filename, ACCEPTED)) continue

      let parsed
      try {
        parsed = parseFrontmatter(file.content)
      } catch (err) {
        errors.push({
          filename: file.filename,
          error: `Failed to parse ${file.filename}: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }

      const fm = parsed.data
      const warnings: string[] = []

      // OpenCode has no `name` key — the filename is the identity. We still
      // honour an explicit `name` if a user hand-added one.
      const name = stringOrUndef(fm.name) ?? nameFromFilename(file.filename)

      const minErr = ensureMinimum(file, name, parsed.body)
      if (minErr) {
        errors.push(minErr)
        continue
      }

      const mode = stringOrUndef(fm.mode)
      if (mode === "primary") {
        warnings.push(
          `"${name}" is an OpenCode primary agent, not a subagent — imported as a delegate anyway.`
        )
      }

      const tools = enabledToolsFromMap(fm.tools)
      if (fm.tools && !tools) {
        warnings.push(`Every tool is disabled in "${name}" — importing with inherited tools.`)
      }

      const { model, providerHint } = splitNamespacedModel(stringOrUndef(fm.model))

      if (fm.permission) {
        warnings.push(
          `OpenCode permission rules for "${name}" weren't imported — set them in Cognia's permission settings.`
        )
      }

      drafts.push(
        buildDraft({
          source: "opencode",
          file,
          name,
          description: stringOrUndef(fm.description),
          systemPrompt: parsed.body,
          tools,
          model,
          providerHint,
          rawFrontmatter: fm,
          warnings,
        })
      )
    }

    return { drafts, errors }
  },
}
