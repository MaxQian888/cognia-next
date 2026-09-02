"use client"

/**
 * Install a template release that arrived over a share link.
 *
 * The narrowest path that already exists is used rather than a new service
 * method: `importPackage` is the ONE place that resolves publisher trust,
 * stamps provenance, writes the releases and rehydrates the catalog, and
 * `exportTemplatePackage` is the one place that produces bytes it will accept.
 * So a single-definition package is built in memory and handed straight back to
 * the importer. Nothing touches disk and nothing new has to be kept in step
 * with the package contract.
 *
 * The round-trip is not ceremony: it is what re-validates the definition on the
 * receiving side. `inspectTemplatePackage` re-runs `validateTemplateDefinition`
 * and `verifyTemplateDefinitionHash` over every definition, so a link carrying
 * a forged content hash or a payload with a credential field is refused by the
 * same code that refuses a tampered file.
 */

import { exportTemplatePackage } from "./package"
import type { TemplateDefinitionEnvelope } from "./contracts"
import type { InspectedTemplatePackage } from "./package"
import type { TemplateService } from "./service"

/** Package ids allow `[a-z0-9._-]`. Definition ids also allow `:`. */
const PACKAGE_ID_SAFE = /[^a-zA-Z0-9._-]+/g

/**
 * A package id derived from the definition id.
 *
 * A share carries one release and no package, but the manifest requires a
 * package identity, so it is derived deterministically: two people importing
 * the same shared release get the same `id@version` key and the second import
 * replaces the first rather than accumulating look-alike rows.
 */
export function sharedDefinitionPackageId(definitionId: string): string {
  const cleaned = definitionId
    .replace(PACKAGE_ID_SAFE, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "")
    .slice(0, 110)
  return `${cleaned || "shared-template"}.link`
}

export interface InstallSharedDefinitionInput {
  definition: TemplateDefinitionEnvelope
  /** The share URL, recorded as `provenance.sourceUrl`. */
  sourceUrl?: string
}

export interface InstallSharedDefinitionDeps {
  /** Injected in tests. Production passes the app's own template service. */
  service: Pick<TemplateService, "importPackage">
}

/**
 * Build the one-definition package and import it as a link-sourced release.
 *
 * Trust is deliberately left to `importPackage`, which resolves it from the
 * manifest signature. A share link carries no signature, so the release lands
 * as `unsigned`, which is the truth: a link proves nothing about who wrote what
 * is behind it.
 */
export async function installSharedTemplateDefinition(
  input: InstallSharedDefinitionInput,
  deps: InstallSharedDefinitionDeps
): Promise<InspectedTemplatePackage> {
  const { definition } = input
  if (!definition.version) {
    throw new Error("A shared template must be a published release")
  }
  const built = await exportTemplatePackage({
    id: sharedDefinitionPackageId(definition.id),
    version: definition.version,
    name: definition.metadata.name.trim() || definition.id,
    ...(definition.metadata.description ? { description: definition.metadata.description } : {}),
    entrypoints: [definition.id],
    definitions: [definition],
  })
  return deps.service.importPackage(built.bytes, {
    source: "link",
    confirmed: true,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
  })
}
