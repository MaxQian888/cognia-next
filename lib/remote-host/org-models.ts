/**
 * Organization model access on a multi-tenant Host (plan §9b.1, P6a).
 *
 * An org owner or admin keeps the org's model provider keys on the Host and
 * picks which bundled agents members may run. Every call goes over the Host's
 * management channel, like "Secrets on this host"; the Host derives the org
 * from the signed-in person, never from an argument, and re-checks live owner
 * or admin standing on every call. Keys only ever go to the Host: what comes
 * back is the provider, a short fingerprint, and who set it when.
 */

import {
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"

export interface OrgCredentialEntry {
  provider: string
  /** First 12 hex of SHA-256(key): tells two keys apart, reveals nothing. */
  fingerprint: string
  /** Unix milliseconds. */
  setAt: number
  /** A `usr_` id, or `operator` for the Host's own command line. */
  setBy: string
}

export interface OrgAgentAvailability {
  runtimeId: string
  /** Org credentials that can serve this agent; empty when none can. */
  providers: string[]
  available: boolean
}

export interface OrgAgentPolicy {
  /** The agents members may run, in the order the admin chose. */
  allowedAgents: OrgAgentAvailability[]
  /** Every agent the Host ships, allowed or not, so a picker can offer them. */
  bundledAgents: OrgAgentAvailability[]
  defaultAgent: string | null
  updatedAt?: number | null
  updatedBy?: string | null
}

export interface OrgModelsDeps {
  channel?: ManagementChannelDeps
}

function call<T>(
  hostRef: string,
  command: string,
  args: Record<string, unknown>,
  deps: OrgModelsDeps
): Promise<T> {
  return withManagementChannel(
    hostRef,
    (lease) => lease.transport.call<T>(command, args),
    deps.channel
  )
}

export async function listOrgCredentials(
  hostRef: string,
  deps: OrgModelsDeps = {}
): Promise<OrgCredentialEntry[]> {
  const rows = await call<OrgCredentialEntry[] | null>(
    hostRef,
    "org_model_credential_list",
    {},
    deps
  )
  return Array.isArray(rows) ? rows : []
}

export function setOrgCredential(
  hostRef: string,
  write: { provider: string; apiKey: string },
  deps: OrgModelsDeps = {}
): Promise<OrgCredentialEntry> {
  return call<OrgCredentialEntry>(
    hostRef,
    "org_model_credential_set",
    { provider: write.provider.trim(), apiKey: write.apiKey.trim() },
    deps
  )
}

export function deleteOrgCredential(
  hostRef: string,
  provider: string,
  deps: OrgModelsDeps = {}
): Promise<void> {
  return call<void>(hostRef, "org_model_credential_delete", { provider }, deps)
}

export function getOrgAgentPolicy(
  hostRef: string,
  deps: OrgModelsDeps = {}
): Promise<OrgAgentPolicy> {
  return call<OrgAgentPolicy>(hostRef, "org_agent_policy_get", {}, deps)
}

export function setOrgAgentPolicy(
  hostRef: string,
  policy: { allowedAgents: string[]; defaultAgent: string | null },
  deps: OrgModelsDeps = {}
): Promise<OrgAgentPolicy> {
  return call<OrgAgentPolicy>(
    hostRef,
    "org_agent_policy_set",
    {
      allowedAgents: policy.allowedAgents,
      ...(policy.defaultAgent ? { defaultAgent: policy.defaultAgent } : {}),
    },
    deps
  )
}

/** One person's model spend for a month (P6b). `null` tokens mean no cap. */
export interface OrgMemberUsage {
  userId: string
  /**
   * The person's name as the org's collaboration plane knows it. Absent when
   * the Host could not ask (or the Host predates it); the panel shows the id.
   */
  displayName?: string
  spentTokens: number
  /** Held by turns still running; released or charged when they settle. */
  reservedTokens: number
  monthlyTokens: number | null
  /** `override` when the person has their own cap, else the org default. */
  capSource: "default" | "override"
}

export interface OrgUsageReport {
  /** `YYYY-MM` in UTC, the Host's billing month. */
  month: string
  defaultMonthlyTokens: number | null
  members: OrgMemberUsage[]
}

/** The Host refuses larger caps (`MAX_MONTHLY_TOKENS` in cognia-gateway). */
export const MAX_ORG_MONTHLY_TOKENS = 1_000_000_000_000

export async function getOrgUsage(
  hostRef: string,
  deps: OrgModelsDeps = {}
): Promise<OrgUsageReport> {
  const report = await call<OrgUsageReport | null>(hostRef, "org_member_usage_get", {}, deps)
  return {
    month: report?.month ?? "",
    defaultMonthlyTokens: report?.defaultMonthlyTokens ?? null,
    members: Array.isArray(report?.members) ? report.members : [],
  }
}

/** The org-wide default cap; `null` lifts it. */
export function setOrgDefaultCap(
  hostRef: string,
  monthlyTokens: number | null,
  deps: OrgModelsDeps = {}
): Promise<void> {
  return call<void>(hostRef, "org_usage_cap_set", { defaultMonthlyTokens: monthlyTokens }, deps)
}

/**
 * One person's cap: a number, `null` for no cap, or `"default"` to drop the
 * override so the org default applies again.
 */
export function setOrgMemberCap(
  hostRef: string,
  userId: string,
  monthlyTokens: number | null | "default",
  deps: OrgModelsDeps = {}
): Promise<void> {
  return call<void>(hostRef, "org_member_usage_cap_set", { userId, monthlyTokens }, deps)
}

/**
 * Why the Host would not answer, as the section shows it. `not-org-host` is a
 * single-user Host (`org_scope_unavailable`): the section has nothing to say
 * there and stays hidden. `not-admin` is a member (`host_surface_forbidden`).
 */
export type OrgModelsRefusal = "not-org-host" | "not-admin"

export function orgModelsRefusal(error: unknown): OrgModelsRefusal | null {
  const code = refusalCode(error)
  if (code === "org_scope_unavailable") return "not-org-host"
  if (code === "host_surface_forbidden" || code === "host_principal_unbound") return "not-admin"
  return null
}

function refusalCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const match = /\b(org_scope_unavailable|host_surface_forbidden|host_principal_unbound)\b/.exec(
    text
  )
  return match?.[1] ?? null
}
