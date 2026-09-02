import type { PluginTemplatesAPI as PublicPluginTemplatesAPI } from "@cognia/plugin-sdk/templates"
import type { PluginTemplatePackageContribution } from "@cognia/plugin-sdk/templates"

import { TemplateCatalog } from "@/lib/templates/catalog"
import {
  canonicalTemplateStringify,
  validateTemplateDefinition,
  verifyTemplateDefinitionHash,
  type TemplateDefinitionEnvelope,
} from "@/lib/templates/contracts"
import { validateTemplatePackageManifest } from "@/lib/templates/package"
import { sha256Bytes } from "@/lib/ocr/hash"
import { sha256Hex } from "@/lib/share/hash"
import type { TemplateService } from "@/lib/templates/service"
import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
import { projectLegacyAgentTeam } from "@/lib/templates/legacy-sources"
import { projectPortableWorkflowValue } from "@/lib/templates/adapters"
import { createTemplateDefinition } from "@/lib/templates/contracts"

export type TemplatePluginPermission =
  "templates:read" | "templates:contribute" | "templates:instantiate" | "templates:library:write"

/**
 * What the user is being asked to allow. Every value other than `instantiate`
 * is a library write and resolves to `templates:library:write` at the consent
 * broker, so the verbs exist to make the prompt say what is about to happen
 * rather than to open a second permission.
 */
export type PluginTemplateConfirmationAction =
  | "instantiate"
  | "library-write"
  | "save-draft"
  | "publish"
  | "fork"
  | "deprecate"
  | "delete-draft"
  | "export-package"
  | "import-package"

export interface PluginTemplateConfirmation {
  pluginId: string
  action: PluginTemplateConfirmationAction
  definitionId: string
  operations?: string[]
}

export type PluginTemplatesAPI = PublicPluginTemplatesAPI

export interface CreateTemplatesAPIDependencies {
  catalog: TemplateCatalog
  service: Pick<
    TemplateService,
    | "createDraft"
    | "preflight"
    | "instantiate"
    | "saveDraft"
    | "publish"
    | "fork"
    | "deprecate"
    | "deleteDraft"
    | "exportPackage"
    | "importPackage"
  >
  hasPermission(permission: TemplatePluginPermission | string): boolean
  confirm(request: PluginTemplateConfirmation): Promise<boolean>
}

const CAPABILITY_PERMISSIONS: Readonly<Record<string, string>> = {
  filesystem: "filesystem:read",
  network: "network:fetch",
  twin: "twin:read",
  execution: "agent:control",
  tool: "agent:control",
}
const subscriptionsByPlugin = new Map<string, Set<() => void>>()

function requirePermission(
  deps: CreateTemplatesAPIDependencies,
  permission: TemplatePluginPermission
): void {
  if (!deps.hasPermission(permission)) {
    throw new Error(`Plugin template API requires permission "${permission}"`)
  }
}

function assertDynamicPluginTemplate(
  pluginId: string,
  definition: TemplateDefinitionEnvelope
): void {
  if (definition.provenance.source !== "plugin" || definition.provenance.pluginId !== pluginId) {
    throw new Error(`Template provenance must identify the active plugin "${pluginId}"`)
  }
  if (!definition.id.startsWith(`${pluginId}:`)) {
    throw new Error(`Dynamic template id must be prefixed with "${pluginId}:"`)
  }
  if (!definition.version || definition.status !== "published") {
    throw new Error("Plugins may dynamically register immutable published releases only")
  }
  const validation = validateTemplateDefinition(definition)
  if (!validation.ok) {
    throw new Error(
      `Plugin template is invalid: ${validation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; ")}`
    )
  }
}

/**
 * One permission and one consent prompt for every library write.
 *
 * Extracted so a method added later cannot land with the permission check and
 * without the prompt, which is exactly how `ctx.team.saveAsTemplate` came to
 * reach `saveDraft` on `team:write` alone.
 */
async function authorizeLibraryWrite(
  deps: CreateTemplatesAPIDependencies,
  pluginId: string,
  action: PluginTemplateConfirmationAction,
  definitionId: string
): Promise<void> {
  requirePermission(deps, "templates:library:write")
  const confirmed = await deps.confirm({ pluginId, action, definitionId })
  if (!confirmed) {
    throw new Error("Plugin template library write was denied by user confirmation")
  }
}

/**
 * Refuse to mutate a library entry this plugin did not create.
 *
 * `templates:library:write` says a plugin may keep templates in the user's
 * library. It does not say it may edit, republish, deprecate or delete the
 * user's own work, or another plugin's. The discriminator is
 * `provenance.pluginId`, which {@link stampPluginAuthorship} writes on every
 * draft this API creates.
 *
 * `version: null` addresses the draft, a string addresses that release. The
 * catalog is the read side: a draft only ever reaches it through the service's
 * own `upsert("user", …)`, and a plugin's self-registered definitions are
 * forced to be published releases under its own `<pluginId>:` prefix
 * (`assertDynamicPluginTemplate`), so neither can impersonate a user draft.
 */
function assertPluginOwnsLibraryEntry(
  deps: CreateTemplatesAPIDependencies,
  pluginId: string,
  id: string,
  version: string | null,
  verb: string
): void {
  const definition = deps.catalog.get(id, version)
  if (!definition) {
    throw new Error(`Template ${id} was not found in the catalog`)
  }
  if (definition.provenance.pluginId !== pluginId) {
    throw new Error(
      `Plugin "${pluginId}" may not ${verb} template ${id}: it belongs to ` +
        (definition.provenance.pluginId
          ? `plugin "${definition.provenance.pluginId}"`
          : "the user's own library")
    )
  }
}

/**
 * Record which plugin created a library draft.
 *
 * `TemplateService.createDraft` hard-codes `provenance: {source: "user"}` and
 * that is correct: ADR-0100 treats a user-library row as the user's, whoever
 * typed it, and changing the source would move these drafts out of the library
 * the Studio reads. So authorship goes in `provenance.pluginId`, which the
 * source leaves free, and the stamp is a second `saveDraft` because the
 * service overwrites whatever provenance a `createDraft` input carried.
 *
 * The draft therefore lands at revision 2 rather than 1. That is visible and
 * deliberate: the alternative is an unattributable row, and every refusal in
 * {@link assertPluginOwnsLibraryEntry} depends on the attribution existing.
 */
async function stampPluginAuthorship(
  deps: CreateTemplatesAPIDependencies,
  pluginId: string,
  draft: TemplateDefinitionEnvelope
): Promise<TemplateDefinitionEnvelope> {
  if (draft.provenance.pluginId === pluginId) return draft
  return deps.service.saveDraft(
    { ...draft, provenance: { ...draft.provenance, pluginId } },
    draft.revision
  )
}

export function createTemplatesAPI(
  pluginId: string,
  deps: CreateTemplatesAPIDependencies
): PluginTemplatesAPI {
  const sourceId = `plugin:${pluginId}`
  const guardedPlans = new Map<string, Awaited<ReturnType<TemplateService["preflight"]>>>()
  return {
    register(definition) {
      requirePermission(deps, "templates:contribute")
      assertDynamicPluginTemplate(pluginId, definition)
      return deps.catalog.register(sourceId, definition)
    },

    registerMany(definitions) {
      requirePermission(deps, "templates:contribute")
      for (const definition of definitions) {
        assertDynamicPluginTemplate(pluginId, definition)
      }
      return deps.catalog.registerMany(sourceId, definitions)
    },

    list() {
      requirePermission(deps, "templates:read")
      return deps.catalog.getSnapshot().definitions
    },

    query(query) {
      requirePermission(deps, "templates:read")
      return deps.catalog.query(query)
    },

    get(id, version) {
      requirePermission(deps, "templates:read")
      return deps.catalog.get(id, version)
    },

    getRevision() {
      requirePermission(deps, "templates:read")
      return deps.catalog.getRevision()
    },

    subscribe(listener) {
      requirePermission(deps, "templates:read")
      const unsubscribe = deps.catalog.subscribe(listener)
      const subscriptions = subscriptionsByPlugin.get(pluginId) ?? new Set<() => void>()
      subscriptions.add(unsubscribe)
      subscriptionsByPlugin.set(pluginId, subscriptions)
      return () => {
        subscriptions.delete(unsubscribe)
        if (subscriptions.size === 0) subscriptionsByPlugin.delete(pluginId)
        unsubscribe()
      }
    },

    validate(definition) {
      requirePermission(deps, "templates:read")
      return validateTemplateDefinition(definition)
    },

    async createDraft(input) {
      await authorizeLibraryWrite(deps, pluginId, "library-write", input.id)
      return stampPluginAuthorship(deps, pluginId, await deps.service.createDraft(input))
    },

    async saveDraft(input, expectedRevision) {
      await authorizeLibraryWrite(deps, pluginId, "save-draft", input.id)
      assertPluginOwnsLibraryEntry(deps, pluginId, input.id, null, "save")
      return deps.service.saveDraft(
        { ...input, provenance: { ...input.provenance, pluginId } },
        expectedRevision
      )
    },

    async publish(id, input) {
      await authorizeLibraryWrite(deps, pluginId, "publish", id)
      assertPluginOwnsLibraryEntry(deps, pluginId, id, null, "publish")
      return deps.service.publish(id, input)
    },

    async fork(definitionId, input) {
      await authorizeLibraryWrite(deps, pluginId, "fork", input.newId)
      // No ownership check on the SOURCE. Deriving an editable copy of somebody
      // else's release is the entire point of a fork, and the copy is a new
      // draft that this plugin then owns. The stamp below is what makes that
      // ownership checkable on the next `saveDraft` or `publish`.
      return stampPluginAuthorship(deps, pluginId, await deps.service.fork(definitionId, input))
    },

    async deprecate(id, version, status) {
      await authorizeLibraryWrite(deps, pluginId, "deprecate", `${id}@${version}`)
      assertPluginOwnsLibraryEntry(deps, pluginId, id, version, "deprecate")
      return deps.service.deprecate(id, version, status)
    },

    async deleteDraft(id) {
      await authorizeLibraryWrite(deps, pluginId, "delete-draft", id)
      assertPluginOwnsLibraryEntry(deps, pluginId, id, null, "delete")
      return deps.service.deleteDraft(id)
    },

    async exportPackage(input) {
      await authorizeLibraryWrite(deps, pluginId, "export-package", input.id)
      return deps.service.exportPackage(input)
    },

    async importPackage(bytes) {
      await authorizeLibraryWrite(deps, pluginId, "import-package", "package")
      // `source: "plugin"` is what the row records, and it is the honest one:
      // this package entered the library because a plugin asked, not because
      // the user opened a file. `confirmed` is the consent just obtained above.
      //
      // `importedBy` re-stamps `provenance.pluginId` on the installed releases
      // with the IMPORTER. Left to the package's own definitions that field
      // names the AUTHOR, and `assertPluginOwnsLibraryEntry` then refused this
      // plugin every `publish` / `deprecate` / `deleteDraft` on the rows it had
      // just installed under the user's own consent. Provenance is outside the
      // content hash, so the package still verifies byte for byte.
      return deps.service.importPackage(bytes, {
        source: "plugin",
        confirmed: true,
        importedBy: { pluginId },
      })
    },

    async preflight(input) {
      requirePermission(deps, "templates:read")
      const plan = await deps.service.preflight(input)
      const definition = plan.definition ?? deps.catalog.get(input.definitionId, input.version)
      if (!definition) return plan
      const missing = definition.capabilities
        .map((capability) => CAPABILITY_PERMISSIONS[capability] ?? capability)
        .filter((permission) => !deps.hasPermission(permission))
      const guarded =
        missing.length === 0
          ? plan
          : {
              ...plan,
              status: "blocked" as const,
              requiresConfirmation: false,
              issues: [
                ...plan.issues,
                ...missing.map((permission) => ({
                  code: "plugin.permission-missing",
                  severity: "blocker" as const,
                  message: `Plugin lacks required domain permission "${permission}"`,
                })),
              ],
            }
      if (guarded.id) {
        if (guarded.status === "blocked") guardedPlans.delete(guarded.id)
        else guardedPlans.set(guarded.id, plan)
      }
      return {
        ...guarded,
        bindings: guarded.bindings.map((binding) =>
          binding.sensitive ? { ...binding, resourceId: `${binding.kind}:bound` } : binding
        ),
      }
    },

    async instantiate(input) {
      requirePermission(deps, "templates:instantiate")
      if (!input.confirmed) {
        throw new Error("Plugin template instantiation requires explicit confirmation")
      }
      const guardedPlan = input.plan.id ? guardedPlans.get(input.plan.id) : undefined
      if (!guardedPlan || guardedPlan.definitionHash !== input.plan.definitionHash) {
        throw new Error("Plugin template preflight plan is missing, expired, or changed")
      }
      if (input.plan.status === "blocked" || guardedPlan.status === "blocked") {
        guardedPlans.delete(input.plan.id!)
        throw new Error("Plugin template preflight plan is blocked")
      }
      const definition = guardedPlan.definition ?? deps.catalog.get(guardedPlan.definitionId)
      const missingPermissions = (definition?.capabilities ?? [])
        .map((capability) => CAPABILITY_PERMISSIONS[capability] ?? capability)
        .filter((permission) => !deps.hasPermission(permission))
      if (missingPermissions.length > 0) {
        guardedPlans.delete(input.plan.id!)
        throw new Error(
          `Plugin template instantiation lacks required domain permission "${missingPermissions[0]}"`
        )
      }
      const confirmed = await deps.confirm({
        pluginId,
        action: "instantiate",
        definitionId: guardedPlan.definitionId,
        operations: guardedPlan.operations.map((operation) => operation.summary),
      })
      if (!confirmed) {
        throw new Error("Plugin template instantiation was denied by user confirmation")
      }
      guardedPlans.delete(input.plan.id!)
      return deps.service.instantiate({ plan: guardedPlan, confirmed: true })
    },
  }
}

export function clearTemplatesForPluginContext(
  pluginId: string,
  catalog: TemplateCatalog
): boolean {
  for (const unsubscribe of subscriptionsByPlugin.get(pluginId) ?? []) unsubscribe()
  subscriptionsByPlugin.delete(pluginId)
  return catalog.removeSource(`plugin:${pluginId}`)
}

export async function registerPluginTemplatePackages(
  pluginId: string,
  packages: readonly PluginTemplatePackageContribution[],
  catalog: TemplateCatalog
): Promise<number> {
  const sourceId = `plugin:${pluginId}`
  const definitions: TemplateDefinitionEnvelope[] = []
  const identities = new Set<string>()
  const packageIds = new Set<string>()
  for (const contribution of packages) {
    const manifest = validateTemplatePackageManifest(contribution.manifest)
    if (packageIds.has(manifest.id)) {
      throw new Error(`Duplicate template package ${manifest.id}`)
    }
    packageIds.add(manifest.id)
    if (!contribution.manifest.id.startsWith(`${pluginId}.`)) {
      throw new Error(`Template package id must be prefixed with "${pluginId}."`)
    }
    const manifestIdentities = new Set(
      contribution.manifest.definitions.map(
        (definition) => `${definition.id}@${definition.version}`
      )
    )
    for (const definition of contribution.definitions) {
      if (
        definition.provenance.source !== "plugin" ||
        definition.provenance.pluginId !== pluginId ||
        definition.provenance.packageId !== contribution.manifest.id
      ) {
        throw new Error(
          `Template package definition ${definition.id} has invalid plugin provenance`
        )
      }
      if (!definition.version || definition.status !== "published") {
        throw new Error("Plugin template packages may contain published releases only")
      }
      const identity = `${definition.id}@${definition.version}`
      if (!manifestIdentities.has(identity)) {
        throw new Error(`Template package manifest does not declare ${identity}`)
      }
      if (identities.has(identity)) {
        throw new Error(`Duplicate template definition ${identity}`)
      }
      assertPluginTemplateDefinition(definition)
      if (!(await verifyTemplateDefinitionHash(definition))) {
        throw new Error(`Plugin template ${identity} has a forged content hash`)
      }
      const record = contribution.manifest.definitions.find(
        (candidate) => candidate.id === definition.id && candidate.version === definition.version
      )!
      const body = canonicalTemplateStringify(definition as never)
      if ((await sha256Hex(body)) !== record.sha256) {
        throw new Error(`Plugin template checksum mismatch for ${identity}`)
      }
      identities.add(identity)
      definitions.push(definition)
    }
    if (manifestIdentities.size !== contribution.definitions.length) {
      throw new Error(`Template package ${manifest.id} has missing inline definitions`)
    }
    const assets = contribution.assets ?? []
    if (assets.length !== manifest.assets.length) {
      throw new Error(`Template package ${manifest.id} has missing inline assets`)
    }
    const assetsByPath = new Map(assets.map((asset) => [asset.path, asset]))
    for (const record of manifest.assets) {
      const asset = assetsByPath.get(record.path)
      if (!asset || (await sha256Bytes(asset.bytes)) !== record.sha256) {
        throw new Error(`Plugin template asset checksum mismatch for ${record.path}`)
      }
    }
  }
  catalog.replaceSource(sourceId, definitions)
  return definitions.length
}

export async function registerLegacyPluginTemplateCompatibility(input: {
  pluginId: string
  agentTeams?: readonly PluginAgentTeamTemplateDef[]
  workflows?: readonly PluginWorkflowTemplateDef[]
  catalog: TemplateCatalog
}): Promise<number> {
  const definitions: TemplateDefinitionEnvelope[] = []
  for (const legacy of input.agentTeams ?? []) {
    const projected = projectLegacyAgentTeam({ ...legacy, isBuiltIn: false })
    definitions.push(
      await createTemplateDefinition({
        ...projected,
        id: `${input.pluginId}:${legacy.id}`,
        status: "published",
        revision: 1,
        version: "0.0.0-compat",
        provenance: {
          source: "plugin",
          pluginId: input.pluginId,
          trust: "unsigned",
        },
      })
    )
  }
  for (const legacy of input.workflows ?? []) {
    definitions.push(
      await createTemplateDefinition({
        id: `${input.pluginId}:${legacy.id}`,
        domain: "workflow",
        status: "published",
        revision: 1,
        version: "0.0.0-compat",
        metadata: {
          name: legacy.name,
          description: legacy.description,
          category: legacy.category,
          icon: legacy.icon,
        },
        payload: projectPortableWorkflowValue({
          name: legacy.name,
          description: legacy.description,
          nodes: legacy.nodes,
          edges: legacy.edges,
          settings: legacy.settings,
          complexity: legacy.complexity,
        }),
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["desktop", "web", "mobile"] },
        provenance: {
          source: "plugin",
          pluginId: input.pluginId,
          trust: "unsigned",
        },
      })
    )
  }
  for (const definition of definitions) {
    assertPluginTemplateDefinition(definition)
    input.catalog.register(`plugin:${input.pluginId}`, definition)
  }
  return definitions.length
}

export function assertPluginTemplateDefinition(definition: TemplateDefinitionEnvelope): void {
  const validation = validateTemplateDefinition(definition)
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => issue.message).join("; "))
  }
}
