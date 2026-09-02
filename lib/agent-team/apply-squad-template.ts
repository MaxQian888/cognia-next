/**
 * "Use this template" as a template-platform instantiation.
 *
 * The settings gallery called `instantiateAgentTeamTemplate` straight against
 * the store, so the squad it produced carried no `TemplateInstanceRecord`. With
 * no instance row there is no lineage: the squad cannot say what it came from,
 * `planUpdate` has nothing to plan against, and Detach has nothing to detach.
 * Every one of those exists in `TemplateService` already and was simply never
 * reached from here (ADR-0100 lists "preflight, instantiate, diff, update,
 * detach" as the full-domain lifecycle).
 *
 * The writer is NOT duplicated. `createAgentTeamTemplateAdapter` drives the
 * same `createTeam` / `addTeammate` / `createTask` through its port, plus the
 * pieces the direct path never had: task dependency ordering, twin-slot
 * binding, per-teammate capability writes, and a rollback that deletes the
 * partial squad when any of it fails.
 *
 * The legacy direct path stays as a fallback for exactly two cases, both of
 * which mean the platform genuinely cannot answer: the feature flag is off, or
 * the definition is not in the catalog at all. The second is real rather than
 * theoretical. A user template mirrored while the flag was off, a plugin
 * unloaded between render and click, and a built-in overlay that has not been
 * projected yet all land there, and refusing to instantiate would be a
 * regression against a gallery that has always worked.
 */

import { loggers } from "@cognia/logging"

import type { TemplateCatalog } from "@/lib/templates/catalog"
import { templateCatalog } from "@/lib/templates/catalog"
import type { TemplatePlatform } from "@/lib/templates/contracts"
import { isUnifiedTemplatePlatformEnabled } from "@/lib/templates/feature-flags"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import type {
  AddTeammateInput,
  AgentTeam,
  AgentTeamTask,
  AgentTeamTemplate,
  AgentTeammate,
  CreateTaskInput,
  CreateTeamInput,
} from "@/types/agent/agent-team"

import { instantiateAgentTeamTemplate } from "./instantiate-template"
import { resolveSquadTemplateDefinition, type SquadTemplateOrigin } from "./squad-template-platform"

const log = loggers.agent

/** The store writes the legacy fallback needs. Unused on the platform route. */
export interface SquadTemplateStoreActions {
  createTeam(input: CreateTeamInput): AgentTeam
  addTeammate(input: AddTeammateInput): AgentTeammate
  createTask(input: CreateTaskInput): AgentTeamTask
}

export interface ApplySquadTemplateInput {
  template: AgentTeamTemplate
  origin?: SquadTemplateOrigin
  platform: TemplatePlatform
  actions: SquadTemplateStoreActions
  runtime?: TemplateRuntime
  /** Defaults to the runtime's own catalog, which is what production wires. */
  catalog?: TemplateCatalog
  /** Overridden in tests. Production reads `NEXT_PUBLIC_UNIFIED_TEMPLATE_PLATFORM`. */
  platformEnabled?: () => boolean
}

export interface ApplySquadTemplateResult {
  teamId: string
  /**
   * `platform` means an instance record was written and the squad has lineage.
   * `legacy` means it was created directly and has none, which is what the
   * provenance panel reports rather than hiding.
   */
  via: "platform" | "legacy"
}

/**
 * A blocked preflight is a refusal with reasons, not a crash. Carrying the
 * codes matters as much as the message: `dependency.required-missing` and
 * `platform.unsupported` are two different things for an operator to fix.
 */
export class SquadTemplateBlockedError extends Error {
  constructor(readonly issues: readonly { code: string; message: string }[]) {
    super(issues.map((issue) => issue.message).join(", ") || "Template preflight was blocked")
    this.name = "SquadTemplateBlockedError"
  }
}

export async function applySquadTemplate(
  input: ApplySquadTemplateInput
): Promise<ApplySquadTemplateResult> {
  const {
    template,
    origin = {},
    platform,
    actions,
    runtime = getTemplateRuntime(),
    platformEnabled = isUnifiedTemplatePlatformEnabled,
  } = input
  // The runtime's catalog, not the module singleton: a caller that injects a
  // runtime injects the catalog with it, and reading past it here would resolve
  // definitions the injected runtime does not have.
  const catalog = input.catalog ?? runtime.catalog ?? templateCatalog

  if (!platformEnabled()) {
    return { teamId: instantiateAgentTeamTemplate(template, actions).id, via: "legacy" }
  }

  const definition = resolveSquadTemplateDefinition(template, origin, catalog)
  if (!definition) {
    log.warn("squad template is not in the catalog, instantiating directly", {
      templateId: template.id,
    })
    return { teamId: instantiateAgentTeamTemplate(template, actions).id, via: "legacy" }
  }

  const plan = await runtime.service.preflight({
    definitionId: definition.id,
    ...(definition.version ? { version: definition.version } : {}),
    platform,
    bindings: {},
  })
  if (plan.status === "blocked") throw new SquadTemplateBlockedError(plan.issues)

  // `confirmed: true` is honest here, not a rubber stamp. A squad template's
  // only binding kind is a twin slot, every one of them is optional, and the
  // gallery passes no bindings at all, so `requiresConfirmation` can only be
  // set by a blocked plan, which never reaches this line.
  const result = await runtime.service.instantiate({ plan, confirmed: true })
  const teamId = result.resources.find((resource) => resource.domain === "agentTeam")?.id
  if (!teamId) throw new Error("Template instantiation returned no squad")
  return { teamId, via: "platform" }
}
