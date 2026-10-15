/**
 * The production wiring of the changeset pipeline and the integration queue
 * (ADR-0227): the real host, the real diff and blob readers, the model the
 * user configured for AI review, and the ADR-0188 acceptance port for the
 * changeset's project.
 *
 * One factory so the Agent Team `merge-all`, the Source Control panel and the
 * workflow node all review and verify the same way; each passes only what it
 * knows (a project id, a signal).
 */

import type { AcceptancePort } from "@cognia/router-fusion"

import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { acceptanceProfileResolver } from "@/lib/router-fusion/runtime/delegate-host-ports"
import {
  createDelegateAcceptancePort,
  defaultAcceptanceSandboxHost,
  resolveProjectContainerImage,
} from "@/lib/router-fusion/verify/code-acceptance-host"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"

import type { ScmHost } from "./host"
import {
  integrateChangesets,
  integrationRootForRevision,
  type IntegrateChangesetsInput,
  type IntegrationOutcome,
} from "./integration/orchestrator"
import {
  changesetRootForRevision,
  reviewChangeset,
  type ChangesetReviewResult,
} from "./review/review-changeset"
import { getSourceControlService, type SourceControlService } from "./service"
import type { IntegrationRun } from "./types"

export interface ScmRuntimeInput {
  /** The project whose approved acceptance profiles verify the change. Null: no checks can run. */
  projectId: string | null
  /** The checkout `.cognia/workspace.json` approvals are keyed by, when it is not the project's own. */
  configRoot?: string | null
  appSettings: AppSettings | null | undefined
  /** The source-control backend (Git unless a caller passes another). */
  service?: SourceControlService
  host?: ScmHost
}

export interface ScmRuntime {
  host: ScmHost
  review(changesetId: string, signal: AbortSignal): Promise<ChangesetReviewResult>
  integrate(input: IntegrateChangesetsInput): Promise<IntegrationOutcome>
}

/**
 * The reviewer model: the Source Control panel's AI-review choice, and only
 * when the user turned AI review on (`gitSettings.reviewAI.enabled`, off by
 * default). With it off there is no reviewer, which the review records as
 * `unavailable` — a human approval, never a silent pass, and never a diff sent
 * to a model the user did not agree to.
 */
export function reviewClientFor(appSettings: AppSettings | null | undefined): LlmClient | null {
  const config = appSettings?.gitSettings?.reviewAI ?? DEFAULT_GIT_SETTINGS.reviewAI
  if (config?.enabled !== true) return null
  return buildUtilityLlmClient({
    session: null,
    appSettings,
    override: { providerOverride: config.providerOverride, model: config.model },
    featureId: "scm.reviewChangeset",
  })
}

function acceptancePort(
  input: ScmRuntimeInput,
  runId: string,
  rootForRevision: (revision: string) => Promise<string | null>,
  executionRoot: string
): AcceptancePort | null {
  if (!input.projectId) return null
  const projectId = input.projectId
  return createDelegateAcceptancePort({
    runId,
    rootForRevision,
    resolveProfile: acceptanceProfileResolver(projectId, input.configRoot),
    sandbox: defaultAcceptanceSandboxHost(),
    newId: () => crypto.randomUUID(),
    resolveImage: () => resolveProjectContainerImage({ projectId, executionRoot }),
  })
}

export function createScmRuntime(input: ScmRuntimeInput): ScmRuntime {
  const scm = input.service ?? getSourceControlService()
  const host = input.host ?? scm.changesets
  const customInstructions = input.appSettings?.gitSettings?.reviewAI?.customInstructions
  return {
    host,
    review: async (changesetId, signal) => {
      const changeset = await host.getChangeset(changesetId)
      const port = changeset
        ? acceptancePort(
            input,
            `changeset:${changesetId}`,
            changesetRootForRevision(changeset),
            changeset.executionRoot
          )
        : null
      return reviewChangeset(changesetId, {
        host,
        readBlob: (repo, ref, path) => scm.readFileAt(repo, ref, path),
        agent: {
          loadDiff: (repo, base, head, path) => scm.diffRevisionFile(repo, base, head, path),
          client: reviewClientFor(input.appSettings),
          ...(customInstructions ? { customInstructions } : {}),
        },
        acceptancePort: port,
        signal,
      })
    },
    integrate: (integration) =>
      integrateChangesets(integration, {
        host,
        acceptancePortFor: input.projectId
          ? (run: IntegrationRun) =>
              acceptancePort(
                input,
                `integration:${run.integrationId}`,
                integrationRootForRevision(run),
                run.worktreePath ?? ""
              ) as AcceptancePort
          : null,
      }),
  }
}

/** Git helpers `integrateTeamRun` needs, over the source-control port. */
export function scmGitPortsFor(scm: SourceControlService = getSourceControlService()) {
  return {
    currentBranch: async (sourceRoot: string): Promise<string | null> =>
      (await scm.status(sourceRoot)).branch,
    branchExists: async (sourceRoot: string, name: string): Promise<boolean> =>
      (await scm.branches(sourceRoot)).some((branch) => !branch.isRemote && branch.name === name),
    createBranch: (sourceRoot: string, name: string, from: string): Promise<void> =>
      scm.createBranch(sourceRoot, name, from),
  }
}
