import type { SiteVisitorPolicy } from "@/types/sites"

export type CloudflareAccessRule =
  | { email: { email: string } }
  | { email_domain: { domain: string } }
  | { group: { id: string } }
  | { everyone: Record<string, never> }

export interface CloudflareAccessPolicySpec {
  name: string
  decision: "allow"
  include: CloudflareAccessRule[]
}

export interface CompiledCloudflareAccessPolicy {
  decision: "deny-all" | "restricted" | "public"
  applicationRequired: boolean
  policies: CloudflareAccessPolicySpec[]
}

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort()
}

export function compileCloudflareAccessPolicy(
  policy: SiteVisitorPolicy
): CompiledCloudflareAccessPolicy {
  switch (policy.mode) {
    case "private":
      // An Access application with no allow policies is deny-by-default.
      return { decision: "deny-all", applicationRequired: true, policies: [] }
    case "identities": {
      const emails = normalizedUnique(policy.emails)
      if (emails.length === 0) throw new Error("restricted site access requires at least one email")
      return {
        decision: "restricted",
        applicationRequired: true,
        policies: [
          {
            name: "Cognia Sites restricted access",
            decision: "allow",
            include: emails.map((email) => ({ email: { email } })),
          },
        ],
      }
    }
    case "domains": {
      const domains = normalizedUnique(policy.domains)
      if (domains.length === 0)
        throw new Error("restricted site access requires at least one domain")
      return {
        decision: "restricted",
        applicationRequired: true,
        policies: [
          {
            name: "Cognia Sites restricted access",
            decision: "allow",
            include: domains.map((domain) => ({ email_domain: { domain } })),
          },
        ],
      }
    }
    case "public":
      // Public means no Access application. A Bypass policy would look similar
      // but would retain an enforcement object that is easy to misread/drift.
      return { decision: "public", applicationRequired: false, policies: [] }
    case "organization":
      if (!policy.organizationId.trim()) {
        throw new Error("organization visitor policy requires a Cloudflare Access group id")
      }
      return {
        decision: "restricted",
        applicationRequired: true,
        policies: [
          {
            name: "Cognia Sites restricted access",
            decision: "allow",
            include: [{ group: { id: policy.organizationId.trim() } }],
          },
        ],
      }
  }
}

function canonicalRule(rule: CloudflareAccessRule): string {
  if ("email" in rule) return `email:${rule.email.email.trim().toLowerCase()}`
  if ("email_domain" in rule) {
    return `domain:${rule.email_domain.domain.trim().toLowerCase()}`
  }
  if ("group" in rule) return `group:${rule.group.id.trim()}`
  return "everyone"
}

function canonicalPolicy(policy: CloudflareAccessPolicySpec): string {
  return JSON.stringify({
    name: policy.name,
    decision: policy.decision,
    include: policy.include.map(canonicalRule).sort(),
  })
}

export function cloudflareAccessPolicyMatches(
  desired: CompiledCloudflareAccessPolicy,
  actual: CloudflareAccessPolicySpec[]
): boolean {
  if (desired.decision === "public") return actual.length === 0
  if (desired.decision === "deny-all") return actual.length === 0
  const desiredPolicies = desired.policies.map(canonicalPolicy).sort()
  const actualPolicies = actual.map(canonicalPolicy).sort()
  return (
    desiredPolicies.length === actualPolicies.length &&
    desiredPolicies.every((policy, index) => policy === actualPolicies[index])
  )
}
