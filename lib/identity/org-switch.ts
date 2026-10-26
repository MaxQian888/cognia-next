/**
 * Read which organizations this profile could work in, and switch to one.
 *
 * Two surfaces offer the switch: the account manager's Identity tab and the
 * sidebar account menu. Both go through here, and here goes through the same
 * `adoptOrganization` the sign-in gate uses, so there is one way to change
 * standing and it is tested once. ADR-0149 section 9.
 *
 * After a switch the binding names another org, and every hook that resolved
 * a collaboration context earlier is holding the old one. `notifyCollabScope
 * Changed` tells them to re-resolve; reloading the window is not required.
 */

import { CollabClient, type CollabAccountMembership } from "@/lib/collab/client"
import { notifyCollabScopeChanged } from "@/lib/collab/scope-events"
import { adoptOrganization, type AdoptedOrganization } from "@/lib/identity/cloud-sign-in-flow"
import { readCloudSessionState, type CloudSessionState } from "@/lib/identity/cloud-session"
import { discoverDeployment, type DeploymentDiscovery } from "@/lib/identity/deployment-discovery"
import { createPlatformFetch } from "@/lib/network/platform-fetch"

export interface OrgSwitchDeps {
  readState?: (localAccountId: string) => Promise<CloudSessionState>
  discover?: () => Promise<DeploymentDiscovery>
  listMemberships?: (
    serviceUrl: string,
    accessToken: string
  ) => Promise<{ memberships: CollabAccountMembership[] }>
  adopt?: typeof adoptOrganization
  /** Defaults to the in-process scope bus. */
  notifyScopeChanged?: () => void
}

export interface OrgSwitchSnapshot {
  state: CloudSessionState
  discovery: DeploymentDiscovery
  /** `null` when there is nothing to list: signed out, official account, no service. */
  memberships: CollabAccountMembership[] | null
  membershipsError: string | null
}

async function defaultListMemberships(serviceUrl: string, accessToken: string) {
  const client = new CollabClient({
    baseUrl: serviceUrl,
    accessToken: async () => accessToken,
    fetchImpl: createPlatformFetch(),
  })
  return client.accountMemberships()
}

export async function loadOrgSwitchSnapshot(
  localAccountId: string,
  deps: OrgSwitchDeps = {}
): Promise<OrgSwitchSnapshot> {
  const [state, discovery] = await Promise.all([
    (deps.readState ?? ((id: string) => readCloudSessionState({ localAccountId: id })))(
      localAccountId
    ),
    (deps.discover ?? (() => discoverDeployment({ localAccountId })))(),
  ])
  if (
    state.status !== "active" ||
    discovery.status !== "ready" ||
    !discovery.collaborationServiceUrl
  ) {
    return { state, discovery, memberships: null, membershipsError: null }
  }
  try {
    const answer = await (deps.listMemberships ?? defaultListMemberships)(
      discovery.collaborationServiceUrl,
      state.session.accessToken
    )
    return { state, discovery, memberships: answer.memberships, membershipsError: null }
  } catch (cause) {
    return {
      state,
      discovery,
      memberships: null,
      membershipsError: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** The org the profile works in now, when it is bound to one. */
export function currentOrgIdOf(snapshot: OrgSwitchSnapshot): string | undefined {
  return snapshot.state.status === "active" ? snapshot.state.identity.orgId : undefined
}

export class OrgSwitchUnavailableError extends Error {
  constructor() {
    super("organization switching needs an active session on a ready deployment")
    this.name = "OrgSwitchUnavailableError"
  }
}

/**
 * Make `membership`'s org the profile's, then tell open views to re-resolve.
 *
 * Throws `OrgSwitchUnavailableError` when the snapshot is not switchable, so a
 * caller never mistakes "nothing happened" for success.
 */
export async function switchOrganization(
  snapshot: OrgSwitchSnapshot,
  membership: CollabAccountMembership,
  localAccountId: string,
  deps: OrgSwitchDeps = {}
): Promise<AdoptedOrganization> {
  if (snapshot.state.status !== "active" || snapshot.discovery.status !== "ready") {
    throw new OrgSwitchUnavailableError()
  }
  const adopted = await (deps.adopt ?? adoptOrganization)(
    snapshot.discovery,
    snapshot.state.session,
    {
      orgId: membership.orgId,
      logtoOrganizationId: membership.logtoOrganizationId ?? "",
      userId: membership.userId,
    },
    { localAccountId }
  )
  ;(deps.notifyScopeChanged ?? notifyCollabScopeChanged)()
  return adopted
}
