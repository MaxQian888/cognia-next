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
  commandHasGhWrite,
  dedupeGithubTargets,
  ghWriteTargets,
  shellCommandOf,
  type GhTargetContext,
} from "./gh-targets"
import { repositoryTarget, unknownGithubTarget, type OutboundTarget } from "./outbound-targets"

function isGithubOperation(definition: { id: string }, action: IntegrationActionDef): boolean {
  return (
    definition.id.toLowerCase() === "github" ||
    (action.operationId?.toLowerCase().startsWith("github.") ?? false)
  )
}

/** True when this action of this integration writes to GitHub. */
export function isGithubWriteAction({
  definition,
  action,
}: Pick<RegisteredIntegrationAction, "definition" | "action">): boolean {
  return isGithubOperation(definition, action) && action.risk !== "read"
}

/**
 * True when an integration talks to GitHub: its id is `github`, or one of its
 * actions is a GitHub operation. A raw request through one of its accounts
 * that is not a read is a GitHub write.
 */
export function isGithubIntegration(definition: {
  id: string
  actions: readonly IntegrationActionDef[]
}): boolean {
  return (
    definition.id.toLowerCase() === "github" ||
    definition.actions.some((action) => isGithubOperation(definition, action))
  )
}

/** The GitHub write action a chat tool calls, or undefined for any other tool. */
export function githubWriteActionOf(toolName: string): RegisteredIntegrationAction | undefined {
  return findIntegrationActionsByToolName(toolName).find(isGithubWriteAction)
}

/** True when calling `toolName` performs a GitHub write through an integration. */
export function isGithubWriteTool(toolName: string): boolean {
  return githubWriteActionOf(toolName) !== undefined
}

/**
 * True when this call writes to GitHub: a GitHub write action's tool, or a
 * shell call whose command has a `gh` write.
 */
export function isGithubWriteCall(toolName: string, input: unknown): boolean {
  if (isGithubWriteTool(toolName)) return true
  const command = shellCommandOf(toolName, input)
  return command !== null && commandHasGhWrite(command)
}

function positiveInteger(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return value.trim()
  return undefined
}

/**
 * The web host of a GitHub API root: `github.com` for `api.github.com` (and
 * when there is no root), else the root's own host, which is where a GitHub
 * Enterprise server serves both its pages and `/api/v3`. Repository targets
 * are named by this host, the same one `gh` and a clone URL use.
 */
export function githubWebHost(apiBaseUrl?: string): string {
  if (!apiBaseUrl) return "github.com"
  try {
    const host = new URL(apiBaseUrl).host.toLowerCase()
    return host === "api.github.com" ? "github.com" : host
  } catch {
    return "github.com"
  }
}

/** `owner/repo` on `host`; a value that already names its host or a URL is read as is. */
function repositoryOn(value: string, thread: string | undefined, host: string | undefined) {
  const bare = /^[^/:@\s]+\/[^/:@\s]+$/.test(value.trim())
  return repositoryTarget(
    bare && host && host !== "github.com" ? `https://${host}/${value.trim()}` : value,
    thread
  )
}

/**
 * Where an integration action's call writes: the repository at each of its
 * `repository` scope selectors (GitHub actions use `/repoFullName`), with the
 * call's `prNumber` (else `issueNumber`) as the thread. A call that names a
 * comment only (`updateComment`) has no thread; one that names no valid
 * repository is {@link unknownGithubTarget}. `host` is the account's web host
 * ({@link githubWebHost}); a bare `owner/repo` is on `github.com` without it.
 */
export function githubActionTargets(
  action: IntegrationActionDef,
  input: unknown,
  options: { host?: string } = {}
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
    return (
      (typeof value === "string" && repositoryOn(value, thread, options.host)) ||
      unknownGithubTarget()
    )
  })
  return dedupeGithubTargets(targets.length > 0 ? targets : [unknownGithubTarget()])
}

/** `/repos/<owner>/<repo>[/issues|pulls/<n>]…`, relative to the API root. */
const REPO_REQUEST_PATH = /^\/repos\/([^/]+)\/([^/]+)(?:\/(?:issues|pulls)\/(\d+)(?:\/|$))?/i

/**
 * Where a raw authenticated GitHub request writes. The path is read relative
 * to the account's API root (`https://api.github.com`, or a GitHub Enterprise
 * `https://host/api/v3`): `/repos/<owner>/<repo>/…` is that repository, with
 * the PR or issue number as the thread when the path names one. Anything else
 * (`/graphql`, `/gists`, `/user/repos`, an encoded or foreign path) is
 * {@link unknownGithubTarget}: it cannot be granted, so it always reaches a
 * person under enforcement.
 */
export function githubRequestTargets(url: string, apiBaseUrl?: string): OutboundTarget[] {
  let parsed: URL
  let base: URL
  try {
    parsed = new URL(url)
    base = new URL(apiBaseUrl ?? "https://api.github.com")
  } catch {
    return [unknownGithubTarget()]
  }
  const root = base.pathname.replace(/\/$/, "")
  if (
    parsed.origin !== base.origin ||
    /%2f|%5c|%2e|\\/i.test(parsed.pathname) ||
    (root && !parsed.pathname.toLowerCase().startsWith(`${root.toLowerCase()}/`))
  ) {
    return [unknownGithubTarget()]
  }
  const match = REPO_REQUEST_PATH.exec(parsed.pathname.slice(root.length))
  const target = match
    ? repositoryOn(`${match[1]}/${match[2]}`, match[3], githubWebHost(base.toString()))
    : undefined
  return [target ?? unknownGithubTarget()]
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
