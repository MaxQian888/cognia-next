import { nanoid } from "nanoid"
import { supportsExternalAgents } from "./agent-transport"
import type {
  CreateExternalAgentInput,
  ExternalAgentBranchReasonCode,
  ExternalAgentConfig,
  ExternalAgentEcosystemPrerequisite,
  ExternalAgentEcosystemPrerequisiteStatus,
  ExternalAgentEcosystemReadinessSnapshot,
  ExternalAgentProtocol,
  ExternalAgentRecommendedAction,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"
import { normalizeExternalAgentValiditySnapshot } from "./canonical-contract"
import { resolveExternalAgentSurfaceFromMetadata } from "./ecosystem-adapters"
import { adaptPermissionMode } from "./permission-modes"
import { protocolAdapterRegistry } from "./protocol-adapter"

// The five protocols with a built-in adapter registered by
// `ExternalAgentManager.registerDefaultAdapters()`. Keeping this in set-equality
// with the registered built-ins is what prevents a fresh `codex-app-server` /
// `a2a` config from being mislabeled `metadata.unsupported` in
// `normalizeExternalAgentConfigInput` (plugin-contributed protocols still pass
// the execution gate via the runtime `protocolAdapterRegistry`).
export const SUPPORTED_EXTERNAL_AGENT_PROTOCOLS = [
  "acp",
  "codex-app-server",
  "opencode",
  "opencode-v2",
  "a2a",
] as const

const DEFAULT_TIMEOUT = 300000
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
  exponentialBackoff: true,
  maxRetryDelay: 30000,
  retryOnErrors: [] as string[],
}

export interface ExternalAgentExecutionBlockAssessment {
  code: ExternalAgentBranchReasonCode
  reason: string
}

export interface ExternalAgentEcosystemProbeOptions {
  runtimeIsTauri?: boolean
  platform?: string
  checkCommandExists?: (command: string) => Promise<boolean>
}

function createUnknownSessionExtensionSupport() {
  return {
    "session/list": { state: "unknown" as const },
    "session/fork": { state: "unknown" as const },
    "session/resume": { state: "unknown" as const },
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/**
 * Drop duplicates while preserving order, across both entry shapes.
 *
 * A structured entry is keyed by its id AND its params: two `installCommand`
 * lines naming different commands are different advice, and collapsing them
 * would silently hide one of them.
 */
function dedupeActions(
  values: Array<ExternalAgentRecommendedAction | undefined>
): ExternalAgentRecommendedAction[] {
  const seen = new Set<string>()
  const out: ExternalAgentRecommendedAction[] = []
  for (const value of values) {
    if (!value) continue
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
      continue
    }
    if (!value.id) continue
    const key = `${value.id}\u0000${JSON.stringify(value.params ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * Coerce persisted entries into the union, dropping anything that is neither.
 *
 * This array round-trips through config metadata, so it is untrusted input:
 * a hand-edited config or a third-party preset can put any JSON here, and an
 * unchecked cast would reach the renderer and print `[object Object]`.
 */
function sanitizeStoredActions(value: unknown): ExternalAgentRecommendedAction[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ExternalAgentRecommendedAction[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim()
      if (trimmed) out.push(trimmed)
      continue
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as { id?: unknown; params?: unknown }
      if (typeof record.id !== "string" || !record.id.trim()) continue
      const params =
        record.params && typeof record.params === "object" && !Array.isArray(record.params)
          ? Object.fromEntries(
              Object.entries(record.params as Record<string, unknown>)
                .filter(([, v]) => typeof v === "string")
                .map(([k, v]) => [k, v as string])
            )
          : undefined
      out.push(
        params && Object.keys(params).length > 0
          ? { id: record.id.trim(), params }
          : { id: record.id.trim() }
      )
    }
  }
  return out.length > 0 ? out : undefined
}

/** The first plain-prose entry, if any — structured ids are not prose. */
function firstProseAction(
  actions: ExternalAgentRecommendedAction[] | undefined
): string | undefined {
  return actions?.find((action): action is string => typeof action === "string")
}

function resolveRuntimePlatform(platform?: string): string | undefined {
  if (platform && platform.trim()) {
    return platform.trim().toLowerCase()
  }

  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform.toLowerCase()
  }

  if (typeof navigator !== "undefined" && typeof navigator.platform === "string") {
    return navigator.platform.toLowerCase()
  }

  return undefined
}

function isWindowsPlatform(platform?: string): boolean {
  if (!platform) {
    return false
  }

  return platform === "win32" || platform.includes("windows")
}

/** Insert `entry`, replacing any existing prerequisite with the same id. */
function upsertPrerequisite(
  prerequisites: ExternalAgentEcosystemPrerequisite[],
  entry: ExternalAgentEcosystemPrerequisite
): void {
  const index = prerequisites.findIndex((item) => item.id === entry.id)
  if (index >= 0) {
    prerequisites[index] = entry
    return
  }
  prerequisites.push(entry)
}

/**
 * Install instruction for the agent CLIs Cognia ships a preset for, so a
 * missing binary reports *how* to get it instead of only that it is absent.
 */
/**
 * The per-CLI install recipe, as a message key rather than prose.
 *
 * One key per CLI instead of one parameterised key, because the recipes differ
 * in more than the package name — Codex also offers Homebrew — and a
 * translator needs the whole sentence to render it naturally.
 */
function installHintForCommand(command: string): ExternalAgentRecommendedAction | undefined {
  switch (command) {
    case "codex":
      return { id: "installHintCodex" }
    case "claude":
      return { id: "installHintClaude" }
    case "opencode":
      return { id: "installHintOpencode" }
    case "gemini":
      return { id: "installHintGemini" }
    default:
      return undefined
  }
}

function resolvePrerequisiteStatus(
  supportTier: ExternalAgentEcosystemReadinessSnapshot["supportTier"],
  prerequisites: ExternalAgentEcosystemPrerequisite[]
): ExternalAgentEcosystemPrerequisiteStatus {
  if (supportTier === "documented-only") {
    return "not-applicable"
  }
  if (prerequisites.some((item) => item.status === "missing")) {
    return "action-required"
  }
  if (prerequisites.some((item) => item.status === "unknown")) {
    return "unknown"
  }
  return "ready"
}

export function getExternalAgentEcosystemReadiness(
  config: Pick<ExternalAgentConfig, "metadata" | "transport">,
  runtimeIsTauri = supportsExternalAgents()
): ExternalAgentEcosystemReadinessSnapshot | undefined {
  const resolved = resolveExternalAgentSurfaceFromMetadata(config.metadata)
  const metadata = config.metadata ?? {}
  const storedReadiness = asRecord(metadata.ecosystemReadiness)

  const adapterId = resolved?.adapter.id ?? asNonEmptyString(metadata.ecosystemAdapterId)
  const adapterName = resolved?.adapter.name ?? asNonEmptyString(metadata.ecosystemAdapterName)
  const surfaceId = resolved?.surface.id ?? asNonEmptyString(metadata.ecosystemSurfaceId)
  const surfaceName = resolved?.surface.name ?? asNonEmptyString(metadata.ecosystemSurfaceName)
  const supportTier =
    resolved?.surface.supportTier ??
    (asNonEmptyString(metadata.ecosystemSupportTier) as
      ExternalAgentEcosystemReadinessSnapshot["supportTier"] | undefined)
  const executionMode =
    resolved?.surface.executionMode ??
    (asNonEmptyString(metadata.ecosystemExecutionMode) as
      ExternalAgentEcosystemReadinessSnapshot["executionMode"] | undefined)
  const docsUrl =
    resolved?.surface.docsUrl ??
    resolved?.adapter.docsUrl ??
    asNonEmptyString(metadata.ecosystemDocsUrl)
  const limitationNote =
    resolved?.surface.limitationNote ?? asNonEmptyString(metadata.ecosystemLimitationNote)
  const envVarHint = resolved?.surface.envVarHint ?? asNonEmptyString(metadata.envVarHint)
  const setupHint =
    resolved?.surface.setupHint ??
    asNonEmptyString(metadata.ecosystemSetupHint) ??
    asNonEmptyString(metadata.setupHint)
  const storedPrerequisiteStatus = (asNonEmptyString(storedReadiness?.prerequisiteStatus) ??
    asNonEmptyString(metadata.ecosystemPrerequisiteStatus)) as
    ExternalAgentEcosystemPrerequisiteStatus | undefined
  const storedPrerequisites = Array.isArray(storedReadiness?.prerequisites)
    ? (storedReadiness?.prerequisites as ExternalAgentEcosystemPrerequisite[])
    : undefined
  const storedRecommendedActions = Array.isArray(storedReadiness?.recommendedActions)
    ? sanitizeStoredActions(storedReadiness?.recommendedActions)
    : Array.isArray(metadata.ecosystemRecommendedActions)
      ? sanitizeStoredActions(metadata.ecosystemRecommendedActions)
      : undefined

  // A config with no ecosystem identity still gets a snapshot once a probe has
  // stored one — that is how the launch preflight (`local-command`) reaches the
  // execution gate for hand-written stdio agents, which resolve no adapter or
  // surface at all.
  if (!adapterId && !surfaceId && !supportTier && !docsUrl && !limitationNote && !storedReadiness) {
    return undefined
  }

  if (storedReadiness) {
    return {
      adapterId,
      adapterName,
      surfaceId,
      surfaceName,
      supportTier,
      executionMode,
      docsUrl,
      limitationNote,
      prerequisiteStatus: storedPrerequisiteStatus,
      prerequisites: storedPrerequisites,
      recommendedActions: storedRecommendedActions,
    }
  }

  const prerequisites: ExternalAgentEcosystemPrerequisite[] = []

  if ((resolved?.surface.transport ?? config.transport) === "stdio") {
    prerequisites.push({
      id: "desktop-runtime",
      label: "Desktop runtime",
      status: runtimeIsTauri ? "satisfied" : "missing",
      detail: "Run Cognia in desktop (Tauri) runtime to use stdio-based external agents.",
    })
  }

  if (envVarHint) {
    prerequisites.push({
      id: "environment",
      label: "Environment setup",
      status: "unknown",
      detail: envVarHint,
    })
  }

  if (setupHint) {
    prerequisites.push({
      id: supportTier === "documented-only" ? "official-surface" : "agent-setup",
      label: supportTier === "documented-only" ? "Official surface guidance" : "Agent setup",
      status: supportTier === "documented-only" ? "not-applicable" : "unknown",
      detail: setupHint,
    })
  } else if (supportTier === "documented-only" && limitationNote) {
    prerequisites.push({
      id: "official-surface",
      label: "Official surface guidance",
      status: "not-applicable",
      detail: limitationNote,
    })
  }

  const prerequisiteStatus = resolvePrerequisiteStatus(supportTier, prerequisites)
  const recommendedActions = dedupeActions([
    !runtimeIsTauri && (resolved?.surface.transport ?? config.transport) === "stdio"
      ? "Open Cognia desktop app before connecting to this local stdio surface."
      : undefined,
    envVarHint,
    setupHint,
    supportTier === "documented-only"
      ? (limitationNote ??
        "Use the linked official product workflow because this surface is not directly executable in Cognia yet.")
      : undefined,
    docsUrl ? `Review official docs: ${docsUrl}` : undefined,
  ])

  return {
    adapterId,
    adapterName,
    surfaceId,
    surfaceName,
    supportTier,
    executionMode,
    docsUrl,
    limitationNote,
    prerequisiteStatus,
    prerequisites,
    recommendedActions,
  }
}

export async function probeExternalAgentEcosystemReadiness(
  config: Pick<ExternalAgentConfig, "metadata" | "transport" | "process">,
  options: ExternalAgentEcosystemProbeOptions = {}
): Promise<ExternalAgentEcosystemReadinessSnapshot | undefined> {
  const runtimeIsTauri = options.runtimeIsTauri ?? supportsExternalAgents()
  const readiness = getExternalAgentEcosystemReadiness(config, runtimeIsTauri)
  const command = config.transport === "stdio" ? config.process?.command?.trim() : undefined
  // The launch preflight applies to any stdio config that spawns a local
  // binary — including hand-written ones that resolve no ecosystem surface.
  // Without this a missing CLI slipped past the execution gate and surfaced as
  // a raw "Failed to spawn process: No such file or directory (os error 2)".
  const canProbeCommand = Boolean(command) && runtimeIsTauri && Boolean(options.checkCommandExists)
  if (!readiness && !canProbeCommand) {
    return undefined
  }

  const prerequisites = [...(readiness?.prerequisites ?? [])]
  const recommendedActions = [...(readiness?.recommendedActions ?? [])]
  const runtimePlatform = resolveRuntimePlatform(options.platform)

  if (command && canProbeCommand) {
    const commandExists = await options.checkCommandExists!(command)

    // Replace rather than append: this probe re-runs on every connect, and a
    // stale entry from an earlier run would keep a since-uninstalled CLI
    // looking satisfied (and pile up duplicates in the UI list).
    upsertPrerequisite(prerequisites, {
      id: "local-command",
      label: "Local command",
      status: commandExists ? "satisfied" : "missing",
      detail: commandExists
        ? `Required command "${command}" was found and is launchable.`
        : `Required command "${command}" was not found on PATH or in the standard install locations (Homebrew, ~/.local/bin, npm/pnpm/bun/cargo global bins).`,
    })

    if (!commandExists) {
      recommendedActions.push({ id: "installCommand", params: { command } })
      const installHint = installHintForCommand(command)
      if (installHint) {
        recommendedActions.push(installHint)
      }
    }
  }

  if (
    readiness?.adapterId === "codex" &&
    readiness.surfaceId === "acp-stdio" &&
    isWindowsPlatform(runtimePlatform)
  ) {
    recommendedActions.push({ id: "codexWsl2" })
  }

  return {
    ...readiness,
    prerequisites,
    prerequisiteStatus: resolvePrerequisiteStatus(readiness?.supportTier, prerequisites),
    recommendedActions: dedupeActions(recommendedActions),
  }
}

export function projectExternalAgentReadinessMetadata(
  metadata: Record<string, unknown>,
  readiness: ExternalAgentEcosystemReadinessSnapshot
): Record<string, unknown> {
  return {
    ...metadata,
    ecosystemAdapterId: readiness.adapterId,
    ecosystemAdapterName: readiness.adapterName,
    ecosystemSurfaceId: readiness.surfaceId,
    ecosystemSurfaceName: readiness.surfaceName,
    ecosystemSupportTier: readiness.supportTier,
    ecosystemExecutionMode: readiness.executionMode,
    ecosystemDocsUrl: readiness.docsUrl,
    ecosystemLimitationNote: readiness.limitationNote,
    ecosystemPrerequisiteStatus: readiness.prerequisiteStatus,
    ecosystemRecommendedActions: readiness.recommendedActions,
    ecosystemReadiness: readiness,
  }
}

export function isSupportedExternalAgentProtocol(
  protocol: ExternalAgentProtocol
): protocol is (typeof SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)[number] {
  return SUPPORTED_EXTERNAL_AGENT_PROTOCOLS.includes(
    protocol as (typeof SUPPORTED_EXTERNAL_AGENT_PROTOCOLS)[number]
  )
}

export function getUnsupportedProtocolReason(protocol: ExternalAgentProtocol): string {
  if (isSupportedExternalAgentProtocol(protocol)) {
    return ""
  }
  // A namespaced `${pluginId}:${id}` protocol is contributed by a plugin
  // adapter. Reaching here means it is not currently registered — almost
  // always because the providing plugin is disabled or not installed.
  if (typeof protocol === "string" && protocol.includes(":")) {
    return `Protocol "${protocol}" is provided by a plugin adapter that is not currently registered. Enable the plugin that contributes it, then reconnect.`
  }
  return `Protocol "${protocol}" is not executable yet. Please migrate this configuration to ACP.`
}

export function isTransportSupportedOnCurrentPlatform(
  transport: ExternalAgentTransport,
  runtimeIsTauri = supportsExternalAgents()
): boolean {
  if (transport !== "stdio") {
    return true
  }
  return runtimeIsTauri
}

export function getExternalAgentExecutionBlockReason(
  config: ExternalAgentConfig,
  runtimeSupportsExternalAgents = supportsExternalAgents()
): string | null {
  const assessment = getExternalAgentExecutionBlock(config, runtimeSupportsExternalAgents)
  return assessment?.reason ?? null
}

export function getExternalAgentExecutionBlock(
  config: ExternalAgentConfig,
  runtimeSupportsExternalAgents = supportsExternalAgents()
): ExternalAgentExecutionBlockAssessment | null {
  if (!config.enabled) {
    return {
      code: "agent_disabled",
      reason: "Agent is disabled.",
    }
  }
  // A built-in supported protocol OR a plugin-contributed adapter currently
  // registered in the runtime registry both count as executable. The registry
  // check is what lets an `external-agent-adapter` plugin's protocol pass the
  // gate while its plugin is enabled (and correctly fall back to blocked once
  // the plugin is disabled and its adapter is unregistered).
  if (
    !isSupportedExternalAgentProtocol(config.protocol) &&
    !protocolAdapterRegistry.has(config.protocol)
  ) {
    return {
      code: "protocol_unsupported",
      reason: getUnsupportedProtocolReason(config.protocol),
    }
  }
  if (!isTransportSupportedOnCurrentPlatform(config.transport, runtimeSupportsExternalAgents)) {
    return {
      code: "transport_blocked",
      reason: "The stdio transport requires the desktop (Tauri) runtime.",
    }
  }
  // An OpenCode config without an explicit endpoint auto-spawns `opencode
  // serve` (see OpenCodeClientAdapter.resolveBaseUrl), which needs the desktop
  // process bridge. Without this gate the browser marks the agent executable
  // and the desktop-only error surfaces later, at connect time.
  if (
    config.protocol === "opencode" &&
    !runtimeSupportsExternalAgents &&
    !config.network?.endpoint &&
    (config.metadata?.autoSpawnServer === true || Boolean(config.process?.command))
  ) {
    return {
      code: "transport_blocked",
      reason:
        "Auto-spawning an OpenCode server requires the desktop (Tauri) runtime; configure a server endpoint instead.",
    }
  }
  if (config.protocol === "opencode-v2" && !runtimeSupportsExternalAgents) {
    return {
      code: "transport_blocked",
      reason:
        "OpenCode V2 local-service discovery requires the desktop runtime. Start the service with `opencode2 service start`, then reconnect from Cognia desktop.",
    }
  }
  const ecosystemReadiness = getExternalAgentEcosystemReadiness(
    config,
    runtimeSupportsExternalAgents
  )
  if (ecosystemReadiness?.supportTier === "documented-only") {
    return {
      code: "ecosystem_documented_only",
      reason:
        ecosystemReadiness.limitationNote ??
        // Only a legacy prose entry can stand in for a reason string; a
        // structured entry is a message key and would render as its id.
        firstProseAction(ecosystemReadiness.recommendedActions) ??
        "This official surface is documented but not directly executable in Cognia yet.",
    }
  }
  const missingPrerequisite = ecosystemReadiness?.prerequisites?.find(
    (item) => item.status === "missing"
  )
  if (missingPrerequisite) {
    return {
      code: "ecosystem_prerequisite_missing",
      reason: missingPrerequisite.detail ?? missingPrerequisite.label,
    }
  }
  return null
}

export function isExternalAgentExecutable(
  config: ExternalAgentConfig,
  runtimeIsTauri = supportsExternalAgents()
): boolean {
  return getExternalAgentExecutionBlockReason(config, runtimeIsTauri) === null
}

export function normalizeExternalAgentConfigInput(
  input: CreateExternalAgentInput,
  options?: {
    id?: string
    now?: Date
    enabled?: boolean
    defaultPermissionMode?: ExternalAgentConfig["defaultPermissionMode"]
    runtimeIsTauri?: boolean
  }
): ExternalAgentConfig {
  const now = options?.now ?? new Date()
  const protocol = input.protocol
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  }

  if (!isSupportedExternalAgentProtocol(protocol)) {
    metadata.unsupported = true
    metadata.unsupportedProtocol = protocol
    metadata.unsupportedReason = getUnsupportedProtocolReason(protocol)
  } else {
    delete metadata.unsupported
    delete metadata.unsupportedProtocol
    delete metadata.unsupportedReason
  }

  const runtimeIsTauri = options?.runtimeIsTauri ?? supportsExternalAgents()
  const normalizedConfigBase: ExternalAgentConfig = {
    id: options?.id ?? nanoid(),
    name: input.name.trim(),
    description: input.description,
    protocol,
    transport: input.transport,
    enabled: options?.enabled ?? true,
    process: input.process,
    network: input.network,
    // Clamp the stored default to a mode this protocol can actually enforce so
    // a persisted config never carries a backend-incompatible mode (e.g. Codex
    // has no `dontAsk`). The runtime applies the same adaptation per session.
    defaultPermissionMode: adaptPermissionMode(
      input.defaultPermissionMode ?? options?.defaultPermissionMode ?? "default",
      protocol
    ).mode,
    autoApprovePatterns: input.autoApprovePatterns,
    requireApprovalFor: input.requireApprovalFor,
    codexOptions: input.codexOptions,
    timeout: input.timeout ?? DEFAULT_TIMEOUT,
    retryConfig: {
      maxRetries: input.retryConfig?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      retryDelay: input.retryConfig?.retryDelay ?? DEFAULT_RETRY_CONFIG.retryDelay,
      exponentialBackoff:
        input.retryConfig?.exponentialBackoff ?? DEFAULT_RETRY_CONFIG.exponentialBackoff,
      maxRetryDelay: input.retryConfig?.maxRetryDelay ?? DEFAULT_RETRY_CONFIG.maxRetryDelay,
      retryOnErrors: input.retryConfig?.retryOnErrors ?? DEFAULT_RETRY_CONFIG.retryOnErrors,
    },
    tags: input.tags,
    metadata,
    createdAt: now,
    updatedAt: now,
  }

  const ecosystemReadiness = getExternalAgentEcosystemReadiness(
    normalizedConfigBase,
    runtimeIsTauri
  )
  if (ecosystemReadiness) {
    Object.assign(metadata, projectExternalAgentReadinessMetadata(metadata, ecosystemReadiness))
  }

  const blockAssessment = getExternalAgentExecutionBlock(normalizedConfigBase, runtimeIsTauri)
  const validitySnapshot = normalizeExternalAgentValiditySnapshot(
    {
      ...input.validitySnapshot,
      executable: input.validitySnapshot?.executable ?? blockAssessment === null,
      checkedAt: input.validitySnapshot?.checkedAt ?? now,
      source: input.validitySnapshot?.source ?? "config",
      blockingReasonCode: blockAssessment?.code ?? input.validitySnapshot?.blockingReasonCode,
      blockingReason: blockAssessment?.reason ?? input.validitySnapshot?.blockingReason,
      healthStatus: input.validitySnapshot?.healthStatus ?? "unknown",
      sessionExtensions:
        input.validitySnapshot?.sessionExtensions ?? createUnknownSessionExtensionSupport(),
      negotiation: input.validitySnapshot?.negotiation ?? {
        protocol,
      },
      ecosystem: ecosystemReadiness ?? input.validitySnapshot?.ecosystem,
      lastBranchReasonCode: blockAssessment?.code ?? input.validitySnapshot?.lastBranchReasonCode,
      lastBranchReason: blockAssessment?.reason ?? input.validitySnapshot?.lastBranchReason,
      lastBranchAt:
        blockAssessment?.code || input.validitySnapshot?.lastBranchAt
          ? (input.validitySnapshot?.lastBranchAt ?? now)
          : undefined,
    },
    {
      fallbackProtocol: protocol,
      fallbackSource: input.validitySnapshot?.source ?? "config",
    }
  )

  return {
    ...normalizedConfigBase,
    validitySnapshot,
  }
}
