import { getDb } from "@/lib/db/schema"
import {
  getWorkflowApp,
  resolvePublishedWorkflowAppByDomain,
  updateWorkflowAppDraft,
} from "@/lib/db/workflow-apps"
import { proxyFetch } from "@/lib/network/proxy-fetch"

const TXT_PREFIX = "cognia-verification="

export class WorkflowCustomDomainError extends Error {
  constructor(
    readonly code:
      | "app_not_found"
      | "invalid_domain"
      | "domain_in_use"
      | "verification_not_requested"
      | "verification_failed",
    message: string
  ) {
    super(message)
    this.name = "WorkflowCustomDomainError"
  }
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "")
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname
    )
  ) {
    throw new WorkflowCustomDomainError("invalid_domain", "A valid public hostname is required")
  }
  return hostname
}

function verificationToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`
}

async function defaultResolveTxt(name: string): Promise<string[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query")
  url.searchParams.set("name", name)
  url.searchParams.set("type", "TXT")
  const response = await proxyFetch(url, {
    headers: { Accept: "application/dns-json" },
    timeout: 10_000,
    blockPrivateHosts: true,
  })
  if (!response.ok) throw new Error(`dns_${response.status}`)
  const body = (await response.json()) as { Answer?: Array<{ data?: string }> }
  return (body.Answer ?? []).flatMap((answer) =>
    typeof answer.data === "string" ? [answer.data.replace(/^"|"$/g, "")] : []
  )
}

export async function requestWorkflowCustomDomainVerification(input: {
  accountId: string
  appId: string
  expectedRevision: number
  hostname: string
  now?: number
}) {
  const app = await getWorkflowApp(input.appId)
  if (!app || app.accountId !== input.accountId) {
    throw new WorkflowCustomDomainError("app_not_found", "Workflow app was not found")
  }
  const hostname = normalizeHostname(input.hostname)
  const conflict = await getDb()
    .workflowApps.where("accountId")
    .equals(input.accountId)
    .filter(
      (candidate) =>
        candidate.id !== input.appId && candidate.draft.customDomain?.hostname === hostname
    )
    .first()
  if (conflict) {
    throw new WorkflowCustomDomainError("domain_in_use", "Custom domain is already assigned")
  }
  const publishedConflict = await resolvePublishedWorkflowAppByDomain(input.accountId, hostname)
  if (publishedConflict && publishedConflict.app.id !== input.appId) {
    throw new WorkflowCustomDomainError("domain_in_use", "Custom domain is already assigned")
  }
  const token = verificationToken()
  const updated = await updateWorkflowAppDraft({
    accountId: input.accountId,
    appId: input.appId,
    expectedRevision: input.expectedRevision,
    patch: {
      customDomain: {
        hostname,
        verificationStatus: "pending",
        verificationToken: token,
      },
    },
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  return {
    app: updated,
    dnsName: `_cognia.${hostname}`,
    dnsValue: `${TXT_PREFIX}${token}`,
  }
}

export async function verifyWorkflowCustomDomain(input: {
  accountId: string
  appId: string
  expectedRevision: number
  now?: number
  resolveTxt?: (name: string) => Promise<string[]>
}) {
  const app = await getWorkflowApp(input.appId)
  if (!app || app.accountId !== input.accountId) {
    throw new WorkflowCustomDomainError("app_not_found", "Workflow app was not found")
  }
  const domain = app.draft.customDomain
  if (!domain) {
    throw new WorkflowCustomDomainError(
      "verification_not_requested",
      "Custom domain verification was not requested"
    )
  }
  let records: string[]
  try {
    records = await (input.resolveTxt ?? defaultResolveTxt)(`_cognia.${domain.hostname}`)
  } catch {
    throw new WorkflowCustomDomainError(
      "verification_failed",
      "Custom domain could not be verified"
    )
  }
  if (!records.includes(`${TXT_PREFIX}${domain.verificationToken}`)) {
    throw new WorkflowCustomDomainError(
      "verification_failed",
      "DNS verification record was not found"
    )
  }
  return updateWorkflowAppDraft({
    accountId: input.accountId,
    appId: input.appId,
    expectedRevision: input.expectedRevision,
    patch: {
      customDomain: {
        ...domain,
        verificationStatus: "verified",
        verifiedAt: input.now ?? Date.now(),
      },
    },
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}
