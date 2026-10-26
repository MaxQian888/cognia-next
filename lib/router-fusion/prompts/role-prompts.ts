/**
 * The Router + Fusion role prompts as Prompt Center entries (ADR-0236, A13).
 *
 * The package ships the roles-1 text pinned by checksum and never edits it in
 * place. What the user edits here is a separate profile: an action of the
 * user's own that selects `roles-1-custom` runs it, every built-in action keeps
 * running roles-1.
 *
 * The edited text is resolved ONCE, when a run's config snapshot is compiled,
 * and materialized into `roles-1-custom@<first 16 hex of sha256 over the
 * canonical role bodies>`. That version is what the action hash, the route
 * decision and the replay journal record, and the bodies are frozen into the
 * snapshot, so a published edit gives later runs a new action identity while a
 * run already in flight (or resumed by another worker) keeps sending the text
 * it started with.
 *
 * The classifier is not here on purpose: it labels a request before any action
 * is chosen, so it has no per-action version to carry an edit, and an entry
 * whose edit could not change what is sent is forbidden (A16). It always runs
 * the shipped roles-1 classifier text.
 */

import {
  BUILTIN_ROLE_PROFILE,
  CUSTOM_ROLE_PROMPT_VERSION,
  listFusionActions,
  materializeCustomRoleProfile,
  ROLE_PROMPTS,
  type RolePromptName,
  type RolePromptProfile,
} from "@cognia/router-fusion"
import type { RouterFusionSettings } from "@cognia/router-fusion/settings/settings"

import { resolvePrompt, resolvePromptAsync, type ResolvedPrompt } from "@/lib/prompts/resolve"
import { definePrompt, type PromptDefinitionV1 } from "@/lib/prompts/types"

/** The roles a workflow sends: every role but the request classifier. */
export type EditableRoleName = Exclude<RolePromptName, "classifier">

const CONSUMER = "lib/router-fusion/prompts/role-prompts.ts"

interface RoleSpec {
  id: string
  requiredFragments: readonly string[]
  outputContract: string
}

/**
 * The words a role's output is parsed against, taken from the role text
 * itself: the output schema it names and the field or status names the
 * workflow validates.
 */
const ROLE_SPECS: Record<EditableRoleName, RoleSpec> = {
  common: {
    id: "routing.fusion.role.common",
    // The statuses the lead's plan and the worker's report are parsed into.
    requiredFragments: ["need_input/need_approval/blocked"],
    outputContract:
      "Prefixed to every Router + Fusion role's system prompt; each role's output is then validated against that role's schema, and an invalid one is repaired once or fails the step.",
  },
  panel_member: {
    id: "routing.fusion.role.panel-member",
    requiredFragments: ["Candidate", "claim", "evidence_refs"],
    outputContract:
      "Parsed as a Candidate (answer, claims with evidence_refs, assumptions, open_questions); an invalid candidate is repaired once, then dropped from the panel.",
  },
  judge: {
    id: "routing.fusion.role.judge",
    requiredFragments: [
      "JudgeReport",
      "supported_claim_ids",
      "verification_requests",
      "ready_to_synthesize",
    ],
    outputContract:
      "Parsed as a JudgeReport; only supported_claim_ids reach the synthesizer, and verification_requests run only within the run's tool policy and budget.",
  },
  synthesizer: {
    id: "routing.fusion.role.synthesizer",
    requiredFragments: [],
    outputContract:
      "Free text delivered as the panel's answer after the judge's final check; it is not parsed, but the final check can refuse it.",
  },
  lead: {
    id: "routing.fusion.role.lead",
    requiredFragments: ["Subtask", "accept/revise/takeover/blocked"],
    outputContract:
      "The plan is parsed into Subtask drafts the runtime approves before any worker runs; the review is parsed into one of accept/revise/takeover/blocked.",
  },
  worker: {
    id: "routing.fusion.role.worker",
    requiredFragments: ["WorkerResult"],
    outputContract:
      "Parsed into a WorkerResult; its claimed checks are recorded but never counted as passed, only the runtime's acceptance run is.",
  },
  reviewer: {
    id: "routing.fusion.role.reviewer",
    requiredFragments: ["passed/failed/inconclusive", "executed_by"],
    outputContract:
      "Parsed as a review with status passed/failed/inconclusive; an unparsable review is inconclusive, and a model review can fail a result but never pass a failed runtime check.",
  },
  compactor: {
    id: "routing.fusion.role.compactor",
    requiredFragments: ["HandoffState"],
    outputContract:
      "Becomes the HandoffState that replaces the compacted transcript; the runtime re-injects the authoritative goal, revision and hard constraints next to it.",
  },
}

/** The roles in the order a profile lists them. */
export const EDITABLE_ROLE_NAMES = Object.keys(ROLE_SPECS) as EditableRoleName[]

/** One Prompt Center entry per role a Router + Fusion workflow sends. */
export const ROUTER_FUSION_ROLE_PROMPTS: Readonly<Record<EditableRoleName, PromptDefinitionV1>> =
  Object.fromEntries(
    EDITABLE_ROLE_NAMES.map((role) => {
      const spec = ROLE_SPECS[role]
      return [
        role,
        definePrompt({
          id: spec.id,
          contractVersion: 1,
          kind: "role",
          group: "routing",
          operation: "replace-template",
          scopes: ["account"],
          activation: "next-operation",
          // Every role's output is schema-validated by the workflow.
          risk: "protocol",
          hosts: ["app"],
          maxChars: 8_000,
          requiredFragments: spec.requiredFragments,
          outputContract: `${spec.outputContract} Applies only to actions of your own set to the Prompt Center's role prompts; built-in actions always run the shipped roles-1 text.`,
          consumers: [CONSUMER],
          defaultBody: ROLE_PROMPTS[role],
        }),
      ]
    })
  ) as Record<EditableRoleName, PromptDefinitionV1>

/** True when some action the settings list runs the user's role texts. */
export function usesCustomRolePrompts(settings: RouterFusionSettings): boolean {
  return listFusionActions(settings).some(
    (action) => action.prompt_version === CUSTOM_ROLE_PROMPT_VERSION
  )
}

function profileOf(resolved: Record<EditableRoleName, ResolvedPrompt>): RolePromptProfile {
  const prompts = {
    ...Object.fromEntries(EDITABLE_ROLE_NAMES.map((role) => [role, resolved[role].text])),
    // Not editable (see the header): the shipped classifier text.
    classifier: BUILTIN_ROLE_PROFILE.prompts.classifier,
  } as Record<RolePromptName, string>
  return materializeCustomRoleProfile(prompts)
}

/**
 * The user's role texts, resolved together from the loaded override snapshot
 * and materialized. For a synchronous compile; a path that can await uses
 * `resolveCustomRolePromptsAsync` so the snapshot is loaded first.
 */
export function resolveCustomRolePrompts(): RolePromptProfile {
  return profileOf(
    Object.fromEntries(
      EDITABLE_ROLE_NAMES.map((role) => [role, resolvePrompt(ROUTER_FUSION_ROLE_PROMPTS[role])])
    ) as Record<EditableRoleName, ResolvedPrompt>
  )
}

/** As `resolveCustomRolePrompts`, after making sure the override snapshot is loaded. */
export async function resolveCustomRolePromptsAsync(): Promise<RolePromptProfile> {
  // One after another: the first resolution loads the snapshot, the rest read it.
  const resolved = {} as Record<EditableRoleName, ResolvedPrompt>
  for (const role of EDITABLE_ROLE_NAMES) {
    resolved[role] = await resolvePromptAsync(ROUTER_FUSION_ROLE_PROMPTS[role])
  }
  return profileOf(resolved)
}

/**
 * The role texts a run routed under `settings` pins, resolved at run start, or
 * undefined when no action runs them (nothing is resolved then, and the
 * snapshot's digest is the one roles-1 alone gives).
 */
export async function runRolePromptsFor(
  settings: RouterFusionSettings
): Promise<RolePromptProfile | undefined> {
  return usesCustomRolePrompts(settings) ? resolveCustomRolePromptsAsync() : undefined
}
