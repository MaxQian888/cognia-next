/**
 * `cognia plugin import` — pure core.
 *
 * `listCandidates` answers "what could I pick out of this input"; `convert`
 * turns one pick into either a complete plugin project (greenfield) or a
 * rewritten manifest (`--into`). Both operate on text that the caller has
 * already read, so this module has no filesystem, network, or process
 * dependency and is exercised end to end by unit tests.
 */

import { buildCliSkeleton, CLI_EXECUTE_PERMISSION, listCliCandidates } from "./cli-source"
import { resolveIdentity } from "./identity"
import { assembleManifest, type RuntimeNeed } from "./manifest"
import { buildMcpPreset, listMcpCandidates } from "./mcp-source"
import { mergeContribution, parseExistingManifest } from "./merge"
import { renderProject } from "./scaffold"
import { buildSkill, listSkillCandidates } from "./skill-source"
import type { ConvertCandidate, ConvertInput, ConvertResult, ConvertSourceKind } from "./types"
import type { PluginManifest } from "@/types/plugin/plugin"

export * from "./types"
export { CONVERTED_MAIN } from "./manifest"

/** Version recorded as `minAppVersion` when the caller supplies none. */
const FALLBACK_HOST_VERSION = "0.1.0"

/** Suffix appended to a derived plugin id, per source kind. */
const ID_SUFFIX: Record<ConvertSourceKind, string> = {
  mcp: "mcp",
  skill: "skill",
  cli: "tools",
}

/** List what the supplied input offers for `--pick`. */
export function listCandidates(input: ConvertInput): ConvertCandidate[] {
  switch (input.kind) {
    case "mcp":
      return listMcpCandidates(requireText(input), input.sourceName)
    case "skill":
      return listSkillCandidates(requireText(input), input.sourceName)
    case "cli":
      return listCliCandidates(input.binary ?? "")
  }
}

function requireText(input: ConvertInput): string {
  if (typeof input.text !== "string") {
    throw new Error(`--from ${input.kind} needs the source file's contents`)
  }
  return input.text
}

/** The single contribution a conversion produces, in host-facing terms. */
interface Contribution {
  capability: string
  manifestField: string
  entry: { id: string; [key: string]: unknown }
  permissions: string[]
  need: RuntimeNeed
  /** Extra manifest fields that must ship alongside the contribution. */
  extraFields: Partial<PluginManifest>
  identityDefaults: { stem: string; name: string; description: string }
  todos: string[]
  warnings: string[]
  copies: Array<{ from: string; to: string }>
}

function buildContribution(input: ConvertInput): Contribution {
  switch (input.kind) {
    case "mcp": {
      const pick = requirePick(input, "MCP server")
      const { preset, draft, todos } = buildMcpPreset(requireText(input), pick, input.sourceName)
      return {
        capability: "mcp-server-preset",
        manifestField: "mcpServerPresets",
        entry: preset as unknown as { id: string },
        permissions: [],
        need: draft.transport === "stdio" ? "host-process" : "portable",
        extraFields: {},
        identityDefaults: {
          stem: preset.id,
          name: preset.name,
          description: preset.description ?? "",
        },
        todos,
        warnings: [],
        copies: [],
      }
    }
    case "skill": {
      const built = buildSkill(requireText(input), input.resources ?? [], input.sourceName)
      return {
        capability: "skills",
        manifestField: "skills",
        entry: built.skill as unknown as { id: string },
        permissions: [],
        need: built.needsFilesystem ? "host-filesystem" : "portable",
        extraFields: {},
        identityDefaults: {
          stem: built.skill.id,
          name: built.skill.name,
          description: built.skill.description,
        },
        todos: [],
        warnings: built.warnings,
        copies: built.copies,
      }
    }
    case "cli": {
      const built = buildCliSkeleton(input.binary ?? "")
      return {
        capability: "cli-tools",
        manifestField: "cliTools",
        // The skeleton contributes no entries; `entry` is only consumed by
        // the merge path, which refuses an empty contribution below.
        entry: { id: built.binary.name },
        permissions: [CLI_EXECUTE_PERMISSION],
        need: "host-process",
        extraFields: { requires: { binaries: [built.binary] } } as Partial<PluginManifest>,
        identityDefaults: {
          stem: built.binary.name,
          name: built.binary.name,
          description: `Declarative agent tools wrapping the \`${built.binary.name}\` CLI.`,
        },
        todos: built.todos,
        warnings: [],
        copies: [],
      }
    }
  }
}

function requirePick(input: ConvertInput, what: string): string {
  const pick = input.pick?.trim()
  if (!pick) {
    throw new Error(`--pick is required: this input holds more than one ${what}`)
  }
  return pick
}

/** Options the caller resolves from the host / environment. */
export interface ConvertOptions {
  /** Version stamped as `minAppVersion` unless overridden. */
  hostVersion?: string
  /** `author` fallback, typically `git config user.name`. */
  gitAuthor?: string
  /** Existing `plugin.json` contents — presence selects merge mode. */
  existingManifestText?: string
  /** Path used in merge-mode error messages. */
  existingManifestPath?: string
}

/** Convert one picked source entry. */
export function convert(input: ConvertInput, options: ConvertOptions = {}): ConvertResult {
  const contribution = buildContribution(input)

  if (options.existingManifestText !== undefined) {
    if (input.kind === "cli") {
      throw new Error(
        "--into is not supported for --from cli: the skeleton contributes no cliTools entries, " +
          "so there is nothing to merge. Add the capability to your plugin by hand."
      )
    }
    const path = options.existingManifestPath ?? "plugin.json"
    const existing = parseExistingManifest(options.existingManifestText, path)
    // In merge mode the plugin id is fixed by the target directory, so
    // `--id` renames the contribution being added instead. That is what
    // makes the id-collision error actionable.
    const renamed = input.identity?.id?.trim()
    const entry = renamed ? { ...contribution.entry, id: renamed } : contribution.entry
    const { manifest, warnings } = mergeContribution(existing, {
      capability: contribution.capability,
      manifestField: contribution.manifestField,
      entry,
      permissions: contribution.permissions,
      need: contribution.need,
    })
    return {
      mode: "merge",
      pluginId: manifest.id,
      manifest,
      files: new Map([["plugin.json", `${JSON.stringify(manifest, null, 2)}\n`]]),
      copies: contribution.copies,
      todos: contribution.todos,
      warnings: [...contribution.warnings, ...warnings],
    }
  }

  const identity = resolveIdentity(
    {
      ...contribution.identityDefaults,
      suffix: ID_SUFFIX[input.kind],
      hostVersion: options.hostVersion ?? FALLBACK_HOST_VERSION,
      author: options.gitAuthor,
    },
    input.identity
  )

  // The CLI branch ships an empty `cliTools` on purpose; every other
  // branch ships exactly the one entry that was picked.
  const contributions: Partial<PluginManifest> = {
    ...contribution.extraFields,
    [contribution.manifestField]: input.kind === "cli" ? [] : [contribution.entry],
  } as Partial<PluginManifest>

  const manifest = assembleManifest({
    identity,
    capabilities: [contribution.capability],
    permissions: contribution.permissions,
    need: contribution.need,
    contributions,
  })

  return {
    mode: "create",
    pluginId: manifest.id,
    manifest,
    files: renderProject(manifest, input.kind, contribution.todos),
    copies: contribution.copies,
    todos: contribution.todos,
    warnings: contribution.warnings,
  }
}
