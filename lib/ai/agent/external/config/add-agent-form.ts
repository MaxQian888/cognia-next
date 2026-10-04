/**
 * The "add an external agent" form, without the form.
 *
 * Two surfaces add agents: the desktop manager's dialog, which writes the
 * agent into this machine's store, and the phone's full-screen flow, which
 * creates it on the paired Host. They collect the same fields, refuse the same
 * mistakes and must produce the same configuration, so the rules live here and
 * each surface only decides where the result is sent.
 *
 * Validation answers with a code rather than a sentence: the codes are the
 * contract, and each surface owns the copy (and the toast or inline message)
 * that goes with them.
 */

import { shellQuote, tokenizeShellCommand } from "@/lib/mcp/config-transfer"
import { protocolAdapterRegistry } from "@/lib/ai/agent/external/protocol-adapter"
import { isSupportedExternalAgentProtocol } from "@/lib/ai/agent/external/config/config-normalizer"
import { canUseCogniaModels } from "@/lib/ai/agent/external/config/gateway-task"
import {
  getPresetConfig,
  type ExternalAgentPresetConfig,
} from "@/lib/ai/agent/external/config/presets"
import type { AcpPermissionMode, CreateExternalAgentInput } from "@/types/agent/external-agent"
import type { AddAgentFormData } from "@/types/agent/component-types"

export const DEFAULT_TIMEOUT_MS = "300000"
export const DEFAULT_RETRY_MAX_RETRIES = "3"
export const DEFAULT_RETRY_DELAY_MS = "1000"
export const DEFAULT_RETRY_MAX_DELAY_MS = "30000"

export const DEFAULT_ADD_AGENT_FORM_DATA: AddAgentFormData = {
  name: "",
  protocol: "acp",
  transport: "stdio",
  command: "",
  args: "",
  bare: false,
  debug: false,
  endpoint: "",
  autoSpawnServer: false,
  port: "",
  hostname: "",
  serverPassword: "",
  serverUsername: "",
  model: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retryMaxRetries: DEFAULT_RETRY_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  retryExponentialBackoff: true,
  retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  retryOnErrors: "",
}

/** Presets that keep their working directory and environment in plain view. */
const DIRECT_ENVIRONMENT_PRESETS: readonly string[] = ["qoder", "cline", "kimi"]

/**
 * Whether the form shows the working directory and environment directly
 * (Aider and the presets whose setup is mostly environment) rather than
 * behind the generic process-environment section.
 */
export function usesDirectEnvironment(data: AddAgentFormData, presetId: string): boolean {
  return data.protocol === "aider-cli" || DIRECT_ENVIRONMENT_PRESETS.includes(presetId)
}

/** The shape of the form a preset implies, and the process environment it starts with. */
export function addAgentFormForPreset(
  current: AddAgentFormData,
  presetId: string
): { data: AddAgentFormData; processEnv: Record<string, string> | undefined } | null {
  if (!presetId || presetId === "custom") return null
  // getPresetConfig is dynamic-aware (plugin-contributed presets too),
  // matching how every picker is built from getRunnablePresets().
  const preset = getPresetConfig(presetId)
  if (!preset) return null
  const presetPort = preset.metadata?.port
  return {
    processEnv: preset.process?.env,
    data: {
      ...current,
      name: preset.name,
      protocol: preset.protocol,
      transport: preset.transport,
      command: preset.process?.command || "",
      args: preset.process?.args.map(shellQuote).join(" ") || "",
      processEnv: preset.process?.env,
      endpoint: preset.network?.endpoint || "",
      autoSpawnServer: preset.metadata?.autoSpawnServer === true,
      port: typeof presetPort === "number" ? String(presetPort) : "",
      hostname: typeof preset.metadata?.hostname === "string" ? preset.metadata.hostname : "",
      model: typeof preset.metadata?.model === "string" ? preset.metadata.model : "",
    },
  }
}

/** The transport a protocol needs, given the one the form currently holds. */
export function transportForProtocol(
  protocol: AddAgentFormData["protocol"],
  current: AddAgentFormData["transport"]
): AddAgentFormData["transport"] {
  // OpenCode runs over HTTP + SSE; A2A is a remote HTTP (JSON-RPC + optional
  // SSE) protocol — both need a network endpoint rather than a stdio command.
  if (protocol === "opencode" || protocol === "opencode-v2") return "sse"
  if (protocol === "a2a") return "http"
  return current
}

export interface AddAgentFormShape {
  isOpenCode: boolean
  isOpenCodeV2: boolean
  isStdio: boolean
  /** The preset launches a managed runtime, so command and arguments are not the user's. */
  managedRuntime: boolean
  preset: ExternalAgentPresetConfig | null
}

export function addAgentFormShape(data: AddAgentFormData, presetId: string): AddAgentFormShape {
  const isOpenCode = data.protocol === "opencode"
  const isOpenCodeV2 = data.protocol === "opencode-v2"
  const preset = presetId ? getPresetConfig(presetId) : null
  return {
    isOpenCode,
    isOpenCodeV2,
    isStdio: !isOpenCode && !isOpenCodeV2 && data.transport === "stdio",
    managedRuntime: preset?.metadata?.requiresManagedRuntime === true,
    preset,
  }
}

/** Why a form cannot be submitted yet. */
export type AddAgentFormProblem =
  | "unsupportedProtocol"
  | "nameRequired"
  | "endpointRequired"
  | "commandRequired"
  | "cogniaModelInvalid"
  | "argumentsInvalid"
  | "environmentInvalid"

/**
 * Problems that live in the connection settings rather than the name. A
 * surface that folds those settings away has to open them to show the fix.
 */
export const CONNECTION_PROBLEMS: ReadonlySet<AddAgentFormProblem> = new Set([
  "unsupportedProtocol",
  "endpointRequired",
  "commandRequired",
  "cogniaModelInvalid",
  "argumentsInvalid",
  "environmentInvalid",
])

export interface AddAgentFormEnvironment {
  /** The environment as entered, one name per row, including blank and duplicate names. */
  names: readonly string[]
  /** The environment as it will be stored. */
  values: Record<string, string>
}

export function validateAddAgentForm(
  data: AddAgentFormData,
  presetId: string,
  environment: AddAgentFormEnvironment
): AddAgentFormProblem | null {
  // Accept any built-in protocol (acp / codex-app-server / opencode / a2a) OR
  // any plugin-contributed adapter currently registered in the runtime registry
  // (mirrors the registry-aware gate in getExternalAgentExecutionBlock). Using
  // the canonical built-in list keeps every shipping protocol — including A2A —
  // selectable without depending on registry bootstrap order. A disabled-plugin
  // protocol is no longer in the registry, so it stays correctly blocked.
  if (
    !isSupportedExternalAgentProtocol(data.protocol) &&
    !protocolAdapterRegistry.has(data.protocol)
  ) {
    return "unsupportedProtocol"
  }
  if (!data.name.trim()) return "nameRequired"
  const shape = addAgentFormShape(data, presetId)
  if (shape.isOpenCodeV2) {
    // V2 preview discovers an already-running local service through the
    // sidecar. It intentionally has no process or endpoint fields.
  } else if (shape.isOpenCode) {
    // Remote mode (no auto-spawn) needs an endpoint; auto-spawn defaults the
    // command to `opencode`, so nothing else is strictly required.
    if (!data.autoSpawnServer && !data.endpoint.trim()) return "endpointRequired"
  } else if (shape.isStdio && !shape.managedRuntime && !data.command.trim()) {
    return "commandRequired"
  } else if (!shape.isStdio && !data.endpoint.trim()) {
    return "endpointRequired"
  }

  if (
    data.cogniaModel &&
    (!data.cogniaModel.providerId ||
      !data.cogniaModel.modelId ||
      !canUseCogniaModels({
        protocol: data.protocol,
        transport: data.transport,
        process: {
          command: data.command || (data.autoSpawnServer ? "opencode" : ""),
          args: tokenizeShellCommand(data.args) ?? [],
        },
        network:
          data.transport !== "stdio" && !data.autoSpawnServer
            ? { endpoint: data.endpoint }
            : undefined,
        metadata: { ...shape.preset?.metadata, autoSpawnServer: data.autoSpawnServer },
      }))
  ) {
    return "cogniaModelInvalid"
  }
  if (
    (shape.isStdio || (shape.isOpenCode && data.autoSpawnServer)) &&
    !shape.managedRuntime &&
    tokenizeShellCommand(data.args) === null
  ) {
    return "argumentsInvalid"
  }
  const names = environment.names.map((name) => name.trim()).filter(Boolean)
  if (
    names.some((key) => key.includes("=") || key.includes("\0")) ||
    new Set(names).size !== names.length ||
    Object.values(environment.values).some((value) => value.includes("\0"))
  ) {
    return "environmentInvalid"
  }
  return null
}

/**
 * What a valid form adds. `defaultPermissionMode` is the caller's choice where
 * it offers one; without it the protocol's own default applies (Aider alone
 * carries one from its preset, because it would otherwise edit unasked).
 */
export function buildCreateExternalAgentInput(
  data: AddAgentFormData,
  options: { defaultPermissionMode?: AcpPermissionMode } = {}
): CreateExternalAgentInput {
  const toNonNegativeInteger = (value: string, fallback: number): number => {
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed) || parsed < 0) return fallback
    return parsed
  }

  const retryOnErrors = data.retryOnErrors
    .split(/\r?\n|,/)
    .map((pattern) => pattern.trim())
    .filter(Boolean)

  const config: CreateExternalAgentInput = {
    ...(data.preset
      ? { metadata: { ...getPresetConfig(data.preset)?.metadata, preset: data.preset } }
      : {}),
    name: data.name,
    cogniaModel: data.cogniaModel ?? null,
    protocol: data.protocol,
    ...(options.defaultPermissionMode
      ? { defaultPermissionMode: options.defaultPermissionMode }
      : data.protocol === "aider-cli"
        ? {
            defaultPermissionMode: data.preset
              ? (getPresetConfig(data.preset)?.defaultPermissionMode ?? "plan")
              : "plan",
          }
        : {}),
    transport: data.transport,
    timeout: toNonNegativeInteger(data.timeoutMs, Number.parseInt(DEFAULT_TIMEOUT_MS, 10)),
    retryConfig: {
      maxRetries: toNonNegativeInteger(
        data.retryMaxRetries,
        Number.parseInt(DEFAULT_RETRY_MAX_RETRIES, 10)
      ),
      retryDelay: toNonNegativeInteger(
        data.retryDelayMs,
        Number.parseInt(DEFAULT_RETRY_DELAY_MS, 10)
      ),
      exponentialBackoff: data.retryExponentialBackoff,
      maxRetryDelay: toNonNegativeInteger(
        data.retryMaxDelayMs,
        Number.parseInt(DEFAULT_RETRY_MAX_DELAY_MS, 10)
      ),
      retryOnErrors,
    },
  }

  if (data.protocol === "opencode") {
    const metadata: Record<string, unknown> = { ...config.metadata }
    if (data.autoSpawnServer) {
      metadata.autoSpawnServer = true
      config.process = {
        command: data.command.trim() || "opencode",
        args: tokenizeShellCommand(data.args) ?? [],
        cwd: data.processCwd?.trim() || undefined,
        env: data.processEnv ?? {},
      }
      const port = Number.parseInt(data.port, 10)
      if (!Number.isNaN(port) && port > 0) {
        metadata.port = port
      }
    } else if (data.endpoint.trim()) {
      config.network = { endpoint: data.endpoint.trim() }
    }
    if (data.hostname.trim()) {
      metadata.hostname = data.hostname.trim()
    }
    if (data.serverPassword) {
      metadata.serverPassword = data.serverPassword
    }
    if (data.serverUsername.trim()) {
      metadata.serverUsername = data.serverUsername.trim()
    }
    if (data.model.trim()) {
      metadata.model = data.model.trim()
    }
    if (Object.keys(metadata).length > 0) {
      config.metadata = metadata
    }
  } else if (data.protocol === "opencode-v2") {
    config.metadata = { preview: true, localServiceDiscovery: true }
  } else if (data.transport === "stdio") {
    config.process = {
      command: config.metadata?.requiresManagedRuntime ? "" : data.command,
      args: config.metadata?.requiresManagedRuntime ? [] : (tokenizeShellCommand(data.args) ?? []),
      cwd: data.processCwd?.trim() || undefined,
      env: data.processEnv ?? {},
      ...(config.metadata?.requiresManagedRuntime
        ? {
            cwd: data.dshWorkspace?.trim() || undefined,
            ...(data.dshApiKey
              ? { env: { ...data.processEnv, DEEPSEEK_API_KEY: data.dshApiKey } }
              : {}),
          }
        : {}),
      bare: data.bare || undefined,
      debug: data.debug || undefined,
    }
  } else {
    config.network = {
      endpoint: data.endpoint,
    }
  }

  return config
}
