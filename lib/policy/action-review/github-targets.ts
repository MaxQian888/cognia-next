/**
 * Which agent calls write to GitHub, and where each write lands (ADR-0239
 * phase 2). Two surfaces reach GitHub from a turn:
 *
 * - **Integration actions**, registered as chat tools
 *   `integration__<plugin>__<integration>__<action>`. A tool is a GitHub
 *   write when the action belongs to a GitHub integration (its id is
 *   `github`, or its operation id starts `github.`) and its declared risk is
 *   not `read`. Nothing is decided by the tool's short name: `commentpr` from
 *   another plugin or an MCP server is not this action.
 * - **`gh` in a shell command**: `./gh-targets.ts`.
 *
 * Each write becomes a `repository` target with the PR or issue it goes to as
 * its `thread`, or {@link unknownGithubTarget} when the repository cannot be
 * named.
 */

import { readJsonPointer } from "@/lib/integrations/events"
import {
  findIntegrationActionsByToolName,
  type RegisteredIntegrationAction,
} from "@/lib/integrations/registry"
import type { IntegrationActionDef } from "@/types/plugin/plugin-integration"

import {
  dedupeGithubTargets,
  ghWriteTargets,
  shellCommandOf,
  type GhTargetContext,
} from "./gh-targets"
import { repositoryTarget, unknownGithubTarget, type OutboundTarget } from "./outbound-targets"

function isGithubWriteAction({ definition, action }: RegisteredIntegrationAction): boolean {
  const github =
    definition.id.toLowerCase() === "github" ||
    (action.operationId?.toLowerCase().startsWith("github.") ?? false)
  return github && action.risk !== "read"
}

/** The GitHub write action a chat tool calls, or undefined for any other tool. */
export function githubWriteActionOf(toolName: string): RegisteredIntegrationAction | undefined {
  return findIntegrationActionsByToolName(toolName).find(isGithubWriteAction)
}

/** True when calling `toolName` performs a GitHub write through an integration. */
export function isGithubWriteTool(toolName: string): boolean {
  return githubWriteActionOf(toolName) !== undefined
}

function positiveInteger(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return value.trim()
  return undefined
}

/**
 * Where an integration action's call writes: the repository at each of its
 * `repository` scope selectors (GitHub actions use `/repoFullName`), with the
 * call's `prNumber` (else `issueNumber`) as the thread. A call that names a
 * comment only (`updateComment`) has no thread; one that names no valid
 * repository is {@link unknownGithubTarget}.
 */
export function githubActionTargets(
  action: IntegrationActionDef,
  input: unknown
): OutboundTarget[] {
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const thread = positiveInteger(args.prNumber) ?? positiveInteger(args.issueNumber)
  const pointers = (action.scopeSelectors ?? [])
    .filter((selector) => selector.kind === "repository")
    .map((selector) => selector.jsonPointer)
  const targets = pointers.map((pointer) => {
    const value = readJsonPointer(args, pointer)
    return (typeof value === "string" && repositoryTarget(value, thread)) || unknownGithubTarget()
  })
  return dedupeGithubTargets(targets.length > 0 ? targets : [unknownGithubTarget()])
}

/**
 * Every GitHub target a tool call writes to: an integration action's, or the
 * `gh` writes of a shell command. `[]` for a call that writes nothing to GitHub.
 */
export function githubToolCallTargets(
  toolName: string,
  input: unknown,
  context: GhTargetContext = {}
): OutboundTarget[] {
  const action = githubWriteActionOf(toolName)
  if (action) return githubActionTargets(action.action, input)
  const command = shellCommandOf(toolName, input)
  return command ? ghWriteTargets(command, context) : []
}
