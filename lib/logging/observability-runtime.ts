import type { ObservabilityEventScope, ObservabilityRuntime } from "@cognia/logging"

export const INSTALLATION_ID_STORAGE_KEY = "cognia-observability-installation-id"

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ObservabilityRuntimeEnvironment {
  tenantId?: string
  appVersion?: string
  buildId?: string
}

export interface CreateObservabilityRuntimeScopeOptions {
  runtime: ObservabilityRuntime
  processId: string
  module?: string
  pluginId?: string
  storage?: StorageLike
  randomId?: () => string
  environment?: ObservabilityRuntimeEnvironment
}

export interface ResolveObservabilityRuntimeOptions {
  isTauri: boolean
  platformHint?: string
  userAgent: string
}

function randomInstallationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

function installationId(storage: StorageLike | undefined, randomId: () => string): string {
  if (!storage) return randomId()
  try {
    const existing = storage.getItem(INSTALLATION_ID_STORAGE_KEY)
    if (existing) return existing
    const created = randomId()
    storage.setItem(INSTALLATION_ID_STORAGE_KEY, created)
    return created
  } catch {
    return randomId()
  }
}

export function resolveObservabilityRuntime(
  options: ResolveObservabilityRuntimeOptions
): ObservabilityRuntime {
  if (options.isTauri) return "tauri"
  if (options.platformHint === "mobile") {
    return /android/i.test(options.userAgent) ? "capacitor-android" : "capacitor-ios"
  }
  return "browser"
}

export function createObservabilityRuntimeScope(
  options: CreateObservabilityRuntimeScopeOptions
): ObservabilityEventScope {
  const environment = options.environment ?? {}
  const appVersion = environment.appVersion || process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0"
  return {
    tenantId:
      environment.tenantId || process.env.NEXT_PUBLIC_DIAGNOSTIC_TENANT_ID || "cognia-community",
    installationId: installationId(options.storage, options.randomId ?? randomInstallationId),
    runtime: options.runtime,
    processId: options.processId,
    module: options.module ?? "app",
    pluginId: options.pluginId,
    buildId:
      environment.buildId || process.env.NEXT_PUBLIC_BUILD_ID || `${appVersion}-${options.runtime}`,
    appVersion,
    origin: options.runtime === "tauri" ? "tauri" : "frontend",
  }
}
