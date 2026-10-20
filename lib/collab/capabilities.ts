/**
 * What one person may do, and which features are offered, in one org and
 * workspace, as the collaboration server reports it.
 *
 * # This is a mirror, never a gate
 *
 * `GET /v1/orgs/{org}/capabilities` is evaluated by the server on every
 * request: role presets from `cognia-tenant-auth`, rollout policy from the
 * collaboration store. Every state-changing route re-checks both itself. The
 * answer here decides what the UI offers and what it explains, nothing more.
 * A stale or forged copy can grey out a button or reveal one that then fails;
 * it cannot authorize anything.
 *
 * # One contract, pinned
 *
 * The finite lists below are copied from `protocol/collab-capabilities-v1.json`
 * and `capabilities.test.ts` fails if they drift. The Rust side pins the same
 * file. Unknown entries in a response are dropped, not trusted: a newer server
 * may add a feature or action, and an older client simply does not offer it.
 *
 * # An older server
 *
 * A server without the route answers 404 for it, and so does a server asked
 * about a workspace the caller cannot read. `/health` tells the two apart: a
 * server that has the route lists `org-capabilities` among its features.
 */

import { CollabError, type CollabClient } from "./client"

import type { OrgRole, WorkspaceAccessVia, WorkspaceRole } from "@/types/identity"

export const ORG_CAPABILITIES_SCHEMA_VERSION = 1

/** The `/health` feature a server with the capabilities route advertises. */
export const ORG_CAPABILITIES_HEALTH_FEATURE = "org-capabilities"

export const COLLAB_FEATURE_KEYS = [
  "shared-chat",
  "shared-chat-execution",
  "canvas-collaboration",
  "org-governance",
  "environment-binding",
] as const
export type CollabFeatureKey = (typeof COLLAB_FEATURE_KEYS)[number]

/**
 * - `available`: new resources and runs are admitted.
 * - `existing-only`: nothing new; existing resources stay usable, admitted runs drain.
 * - `read-only`: emergency stop; read, export, leave, cancel and delete remain.
 * - `off`: the deployment does not serve the feature at all.
 */
export const COLLAB_FEATURE_STATES = ["available", "existing-only", "read-only", "off"] as const
export type CollabFeatureState = (typeof COLLAB_FEATURE_STATES)[number]

export const COLLAB_FEATURE_REASONS = [
  "deployment_disabled",
  "feature_not_offered",
  "feature_paused",
  "feature_killed",
  "org_denied",
  "workspace_denied",
  "prerequisite_unavailable",
  "client_contract_unsupported",
  "policy_unavailable",
  "execution_isolation_unavailable",
] as const
export type CollabFeatureReason = (typeof COLLAB_FEATURE_REASONS)[number]

export const COLLAB_ACTIONS = [
  "org.members.manage",
  "org.admins.manage",
  "org.ownership.transfer",
  "org.policy.manage",
  "host.global-surfaces",
  "workspace.read",
  "workspace.write",
  "workspace.members.manage",
  "workspace.settings.manage",
  "execution.request",
  "environment.use",
  "environment.manage",
  "credential.use",
  "credential.manage",
  "publish",
  "host.workspace-surfaces",
] as const
export type CollabAction = (typeof COLLAB_ACTIONS)[number]

export interface CollabFeatureDecision {
  key: CollabFeatureKey
  state: CollabFeatureState
  /** `null` exactly when the feature is `available`. */
  reason: CollabFeatureReason | null
  /** The policy revision the decision was made under; 0 when no policy row exists. */
  policyRevision: number
}

export interface CollabStanding {
  orgRole: OrgRole | null
  workspaceRole: WorkspaceRole | null
  via: WorkspaceAccessVia | null
  guest: boolean
}

export interface OrgCapabilities {
  schemaVersion: typeof ORG_CAPABILITIES_SCHEMA_VERSION
  orgId: string
  workspaceId: string | null
  standing: CollabStanding
  actions: ReadonlySet<CollabAction>
  features: Readonly<Record<CollabFeatureKey, CollabFeatureDecision>>
  evaluatedAt: number
}

export type OrgCapabilitiesResult =
  | { status: "ready"; capabilities: OrgCapabilities }
  /** The server predates the route: keep today's behavior, offer nothing new. */
  | { status: "unsupported" }
  /** The workspace does not exist or this person cannot read it. */
  | { status: "hidden" }

export class OrgCapabilitiesParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OrgCapabilitiesParseError"
  }
}

const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member"]
const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["maintainer", "member", "viewer"]
const ACCESS_VIA: readonly WorkspaceAccessVia[] = ["membership", "org-admin"]

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** What the client assumes about a feature the server did not mention. */
function absentDecision(key: CollabFeatureKey): CollabFeatureDecision {
  // A server that answers schema 1 but omits a key is not offering it. The
  // reason is the deployment's, since nothing narrower was said.
  return { key, state: "off", reason: "deployment_disabled", policyRevision: 0 }
}

function parseDecision(raw: unknown): CollabFeatureDecision | null {
  if (!isRecord(raw)) return null
  const key = oneOf(COLLAB_FEATURE_KEYS, raw.key)
  if (!key) return null
  // An unknown state is a state this client cannot honour safely, so it is
  // read as the most closed one rather than guessed at.
  const state = oneOf(COLLAB_FEATURE_STATES, raw.state) ?? "off"
  const reason =
    state === "available"
      ? null
      : (oneOf(COLLAB_FEATURE_REASONS, raw.reason) ??
        (state === "off" ? "deployment_disabled" : "feature_not_offered"))
  const revision =
    typeof raw.policyRevision === "number" && Number.isSafeInteger(raw.policyRevision)
      ? Math.max(0, raw.policyRevision)
      : 0
  return { key, state, reason, policyRevision: revision }
}

/**
 * Read one capabilities response for the scope that was asked about.
 *
 * Throws when the response is for a different org or workspace: an answer for
 * scope A must never populate scope B's view, which is the failure an in-flight
 * request across an org switch would otherwise produce.
 */
export function parseOrgCapabilities(
  raw: unknown,
  expected: { orgId: string; workspaceId: string | null }
): OrgCapabilities {
  if (!isRecord(raw)) throw new OrgCapabilitiesParseError("capabilities response is not an object")
  if (raw.schemaVersion !== ORG_CAPABILITIES_SCHEMA_VERSION) {
    throw new OrgCapabilitiesParseError(
      `unsupported capabilities schema ${String(raw.schemaVersion)}`
    )
  }
  if (raw.orgId !== expected.orgId) {
    throw new OrgCapabilitiesParseError("capabilities response names another organization")
  }
  const workspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId : null
  if (workspaceId !== expected.workspaceId) {
    throw new OrgCapabilitiesParseError("capabilities response names another workspace")
  }

  const standingRaw = isRecord(raw.standing) ? raw.standing : {}
  const standing: CollabStanding = {
    orgRole: oneOf(ORG_ROLES, standingRaw.orgRole),
    workspaceRole: oneOf(WORKSPACE_ROLES, standingRaw.workspaceRole),
    via: oneOf(ACCESS_VIA, standingRaw.via),
    guest: standingRaw.guest === true,
  }

  const actions = new Set<CollabAction>()
  if (Array.isArray(raw.actions)) {
    for (const entry of raw.actions) {
      const action = oneOf(COLLAB_ACTIONS, entry)
      if (action) actions.add(action)
    }
  }

  const decided = new Map<CollabFeatureKey, CollabFeatureDecision>()
  if (Array.isArray(raw.features)) {
    for (const entry of raw.features) {
      const decision = parseDecision(entry)
      // First answer wins: a duplicated key is a server bug, and taking the
      // later one would let ordering decide what the UI offers.
      if (decision && !decided.has(decision.key)) decided.set(decision.key, decision)
    }
  }
  const features = Object.fromEntries(
    COLLAB_FEATURE_KEYS.map((key) => [key, decided.get(key) ?? absentDecision(key)])
  ) as Record<CollabFeatureKey, CollabFeatureDecision>

  const evaluatedAt =
    typeof raw.evaluatedAt === "number" && Number.isFinite(raw.evaluatedAt) ? raw.evaluatedAt : 0

  return {
    schemaVersion: ORG_CAPABILITIES_SCHEMA_VERSION,
    orgId: expected.orgId,
    workspaceId,
    standing,
    actions,
    features,
    evaluatedAt,
  }
}

export interface FetchOrgCapabilitiesInput {
  orgId: string
  workspaceId?: string | null
  signal?: AbortSignal
}

/** Ask the server, telling an older server apart from a hidden workspace. */
export async function fetchOrgCapabilities(
  client: Pick<CollabClient, "capabilities" | "health">,
  input: FetchOrgCapabilitiesInput
): Promise<OrgCapabilitiesResult> {
  const workspaceId = input.workspaceId ?? null
  try {
    const raw = await client.capabilities(input.orgId, workspaceId, input.signal)
    return {
      status: "ready",
      capabilities: parseOrgCapabilities(raw, { orgId: input.orgId, workspaceId }),
    }
  } catch (cause) {
    if (!(cause instanceof CollabError) || cause.status !== 404) throw cause
    const health = await client.health()
    return health.features?.includes(ORG_CAPABILITIES_HEALTH_FEATURE)
      ? { status: "hidden" }
      : { status: "unsupported" }
  }
}

export function featureDecision(
  capabilities: OrgCapabilities,
  key: CollabFeatureKey
): CollabFeatureDecision {
  return capabilities.features[key]
}

/** May a new resource or run be started? */
export function admitsNew(decision: CollabFeatureDecision): boolean {
  return decision.state === "available"
}

/** May existing resources still be changed (posts, edits, member changes)? */
export function allowsMutation(decision: CollabFeatureDecision): boolean {
  return decision.state === "available" || decision.state === "existing-only"
}

/** Are existing resources still served at all? */
export function allowsRead(decision: CollabFeatureDecision): boolean {
  return decision.state !== "off"
}

export function hasAction(capabilities: OrgCapabilities, action: CollabAction): boolean {
  return capabilities.actions.has(action)
}

/**
 * A write the server refused because the feature is not admitted, as opposed
 * to because the person lacks permission. The body names the feature, the
 * state and the reason, so the UI can say which.
 */
export interface FeatureUnavailableRefusal {
  reason: CollabFeatureReason
}

export function featureUnavailableRefusal(cause: unknown): FeatureUnavailableRefusal | null {
  if (!(cause instanceof CollabError) || cause.status !== 403) return null
  if (cause.message !== "feature_unavailable") return null
  const reason = oneOf(COLLAB_FEATURE_REASONS, cause.reason) ?? "feature_not_offered"
  return { reason }
}
