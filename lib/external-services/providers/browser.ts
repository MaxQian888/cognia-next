import {
  createBrowserProfile,
  grantBrowserDomain,
  normalizeBrowserGrantDomain,
} from "@/lib/db/browser-profiles"
import {
  getServiceConnection,
  putServiceConnection,
  updateServiceConnectionStatus,
} from "@/lib/db/external-services"
import { registerExternalCapabilities, registerExternalServices } from "../catalog"
import type { ServiceConnection } from "@/types/external-service"

export interface ConnectBrowserSiteInput {
  name: string
  domains: string[]
  runtimeTargetId: string
  loginStartUrl?: string
  allowUploads?: boolean
  allowDownloads?: boolean
  skillIds?: string[]
}

interface BrowserConnectionDeps {
  createBrowserProfile: typeof createBrowserProfile
  grantBrowserDomain: typeof grantBrowserDomain
  putServiceConnection: typeof putServiceConnection
}

const defaultDeps: BrowserConnectionDeps = {
  createBrowserProfile,
  grantBrowserDomain,
  putServiceConnection,
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function normalizeDomains(domains: string[]): string[] {
  const normalized = [...new Set(domains.map(normalizeBrowserGrantDomain))]
  if (normalized.length === 0) throw new Error("Browser site connection requires a domain")
  return normalized
}

export async function connectBrowserSite(
  input: ConnectBrowserSiteInput,
  deps: BrowserConnectionDeps = defaultDeps
): Promise<ServiceConnection> {
  const name = input.name.trim()
  if (!name) throw new Error("Browser site connection requires a name")
  const domains = normalizeDomains(input.domains)
  if (input.loginStartUrl) {
    const login = new URL(input.loginStartUrl)
    if (!domains.includes(normalizeBrowserGrantDomain(login.hostname))) {
      throw new Error("Browser login URL must use an approved domain")
    }
  }
  const id = `browser:${slug(name)}:${crypto.randomUUID()}`
  const workspaceId = `external-service:${id}`
  const profile = await deps.createBrowserProfile(workspaceId, name)
  await Promise.all(domains.map((domain) => deps.grantBrowserDomain(workspaceId, domain)))
  const now = new Date().toISOString()
  const connection: ServiceConnection = {
    id,
    pluginId: "user",
    serviceId: `website:${slug(name)}`,
    providerId: "browser",
    runtimeTargetId: input.runtimeTargetId,
    accountLabel: name,
    status: input.loginStartUrl ? "needs-auth" : "pending",
    providerFingerprint: `browser:${domains.join(",")}`,
    providerRef: {
      kind: "browser",
      profileId: profile.id,
      workspaceId,
      allowedDomains: domains,
      loginStartUrl: input.loginStartUrl,
      allowUploads: input.allowUploads ?? false,
      allowDownloads: input.allowDownloads ?? true,
      skillIds: input.skillIds,
    },
    enabledSurfaces: ["chat", "workflow"],
    createdAt: now,
    updatedAt: now,
  }
  await deps.putServiceConnection(connection)
  projectBrowserSiteConnection(connection)
  return connection
}

export function projectBrowserSiteConnection(connection: ServiceConnection): void {
  if (connection.providerRef.kind !== "browser") return
  const pluginId = connection.pluginId ?? "user"
  registerExternalServices(pluginId, [
    {
      id: connection.serviceId,
      label: connection.accountLabel ?? connection.serviceId,
      skillIds: connection.providerRef.skillIds,
      fallbackPolicy: "confirm",
      providers: [
        {
          id: connection.providerId,
          kind: "browser",
          contributionId: connection.id,
          priority: 1,
          surfaces: connection.enabledSurfaces,
        },
      ],
    },
  ])
  registerExternalCapabilities(pluginId, connection.serviceId, connection.providerId, [])
}

export async function validateBrowserSiteReadiness(
  connectionId: string,
  readinessFingerprint: string
): Promise<ServiceConnection> {
  const connection = await getServiceConnection(connectionId)
  if (!connection || connection.providerRef.kind !== "browser") {
    throw new Error(`Browser service connection "${connectionId}" was not found`)
  }
  const previous = connection.providerRef.readinessFingerprint
  if (previous && previous !== readinessFingerprint) {
    return updateServiceConnectionStatus(connectionId, "degraded")
  }
  const updated: ServiceConnection = {
    ...connection,
    status: "connected",
    providerRef: { ...connection.providerRef, readinessFingerprint },
    updatedAt: new Date().toISOString(),
  }
  await putServiceConnection(updated)
  return updated
}

const SENSITIVE_FIELD =
  /password|passwd|passcode|otp|one.?time|verification|captcha|cvv|card|payment/i

/** Credentials, OTP/CAPTCHA and payment confirmation must stay in human takeover. */
export function browserInteractionRequiresTakeover(input: {
  fieldName?: string
  inputType?: string
  autocomplete?: string
  purpose?: string
}): boolean {
  return [input.fieldName, input.inputType, input.autocomplete, input.purpose].some(
    (value) => typeof value === "string" && SENSITIVE_FIELD.test(value)
  )
}
