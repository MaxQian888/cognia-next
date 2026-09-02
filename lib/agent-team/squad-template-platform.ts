/**
 * Where a squad template lives in the unified template platform.
 *
 * Squad templates reach the platform by three different routes, and each mints
 * a different definition id, which is why "use this template" and "what is this
 * template's status" both had to guess before this existed.
 *
 * Built-ins are re-projected every boot by `refreshBuiltInTemplateOverlays`
 * under `builtin.agentTeam.<id>`, published at `1.0.0`. Plugin-contributed ones
 * are registered by `registerLegacyPluginTemplateCompatibility` under
 * `<pluginId>:<defId>` at `0.0.0-compat`, which is already the runtime id
 * `projectPluginTemplate` gives them, so the two agree by construction. User
 * templates are mirrored as DRAFTS by `publishSquadTemplateToPlatform` under
 * `legacy.agentTeam.<id>`, and gain releases once published.
 *
 * Nothing here writes. It resolves ids, picks which of a definition's rows a
 * caller means, and reports the platform status a row is in. ADR-0100.
 */

import type { TemplateCatalog } from "@/lib/templates/catalog"
import { templateCatalog } from "@/lib/templates/catalog"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { TemplateDerivation } from "@/lib/templates/repository"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

import { platformIdForSquadTemplate } from "./publish-template-to-platform"

/** How a row in the settings gallery got there. */
export interface SquadTemplateOrigin {
  /** Owning plugin id when the row came from the `agent-team-template` overlay. */
  pluginSource?: string
}

/**
 * The catalog id for one gallery row.
 *
 * A plugin row's runtime id IS its catalog id (`projectPluginTemplate` and
 * `registerLegacyPluginTemplateCompatibility` both build `<pluginId>:<defId>`),
 * so it is returned unchanged rather than re-derived from parts the projection
 * has already thrown away.
 */
export function squadTemplateDefinitionId(
  template: AgentTeamTemplate,
  origin: SquadTemplateOrigin = {}
): string {
  if (origin.pluginSource) return template.id
  const legacyId = platformIdForSquadTemplate(template)
  return template.isBuiltIn ? legacyId.replace(/^legacy\./, "builtin.") : legacyId
}

/**
 * Order two versions newest-last. Tolerates the `0.0.0-compat` the legacy
 * plugin bridge stamps: a pre-release suffix sorts below the same numbers
 * without one, which is what semver says, and what keeps a compat row from
 * outranking a real release that happens to share its numbers.
 */
export function compareTemplateVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, pre] = value.split("-", 2)
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0)
    return { parts, pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre < b.pre ? -1 : 1
}

/** Every catalog row carrying this definition id, whatever its source. */
export function catalogRowsFor(
  definitionId: string,
  catalog: TemplateCatalog = templateCatalog
): TemplateDefinitionEnvelope[] {
  return catalog.getSnapshot().definitions.filter((definition) => definition.id === definitionId)
}

/**
 * The row a "use this" should instantiate.
 *
 * The newest usable release wins over the draft, because a published version is
 * the one another machine could reproduce, and a draft is only reached when
 * nothing has been published. Yanked and tombstoned rows are skipped, since
 * `preflight` blocks them and offering one would only surface that refusal a
 * click later.
 */
export function resolveSquadTemplateDefinition(
  template: AgentTeamTemplate,
  origin: SquadTemplateOrigin = {},
  catalog: TemplateCatalog = templateCatalog
): TemplateDefinitionEnvelope | undefined {
  const rows = catalogRowsFor(squadTemplateDefinitionId(template, origin), catalog).filter(
    (row) => row.status !== "yanked" && row.status !== "tombstone"
  )
  const releases = rows.filter((row) => row.version !== null)
  if (releases.length > 0) {
    return releases.reduce((best, row) =>
      compareTemplateVersions(row.version!, best.version!) > 0 ? row : best
    )
  }
  return rows[0]
}

/** What the templates panel prints next to a user row. */
export interface SquadTemplatePlatformStatus {
  definitionId: string
  /** `absent` means the mirror has not been written yet, or was deleted. */
  state: "absent" | "draft" | "published"
  /** Newest non-yanked release, when there is one. */
  latestVersion?: string
  /** Every release version, oldest first. Drives the export picker. */
  releases: string[]
  /** Set when this definition was created by `service.fork`. */
  derivedFrom?: TemplateDerivation
  /** The draft row, when one exists. `publish` needs its revision. */
  draft?: TemplateDefinitionEnvelope
}

/**
 * Read one template's platform status.
 *
 * Releases come from the repository rather than the catalog because the catalog
 * also holds the per-boot built-in overlay and every plugin's contributions,
 * and a squad template's own releases are exactly the rows this machine stored.
 */
export async function readSquadTemplatePlatformStatus(
  template: AgentTeamTemplate,
  origin: SquadTemplateOrigin = {},
  runtime: TemplateRuntime = getTemplateRuntime()
): Promise<SquadTemplatePlatformStatus> {
  const definitionId = squadTemplateDefinitionId(template, origin)
  const [draft, releases, derivedFrom] = await Promise.all([
    runtime.repository.getDraft(definitionId),
    runtime.repository.listReleases(definitionId),
    runtime.service.getDerivation(definitionId),
  ])
  const usable = releases
    .filter((release) => release.status !== "yanked" && release.version !== null)
    .sort((left, right) => compareTemplateVersions(left.version!, right.version!))
  return {
    definitionId,
    state: usable.length > 0 ? "published" : draft ? "draft" : "absent",
    ...(usable.length > 0 ? { latestVersion: usable[usable.length - 1]!.version! } : {}),
    releases: usable.map((release) => release.version!),
    ...(derivedFrom ? { derivedFrom } : {}),
    ...(draft ? { draft } : {}),
  }
}
