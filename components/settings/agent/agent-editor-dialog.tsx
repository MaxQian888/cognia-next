"use client"

/**
 * AgentEditorDialog — the full create/edit form for an external agent.
 *
 * Extracted from `external-agent-settings.tsx` when the page moved to the
 * rail + overview + inspector layout: the inspector covers quick inline
 * edits, and this dialog stays the deep editor — preset seeding, protocol
 * selection, and every protocol-specific option (Codex sandbox, OpenCode
 * server auth, Pi extension policy, managed DeepSeek Harness).
 */

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ChevronDown, FolderPlus, Globe, PackageIcon, Terminal } from "lucide-react"

import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CogniaModelPicker } from "@/components/agent/external-agent/cognia-model-picker"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"
import { piPackagesHref } from "@/lib/pi-packages/deep-link"
import { externalProtocolOptions } from "@/lib/ai/agent/external/protocol-options"
import { canUseCogniaModels } from "@/lib/ai/agent/external/config/gateway-task"
import { getPresetConfig, getRunnablePresets } from "@/lib/ai/agent/external/config/presets"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/policy/permission-modes"
import {
  extensionPolicyArgs,
  resolvePiExtensionPolicy,
  type PiExtensionPolicy,
} from "@/lib/ai/agent/external/runtimes/pi/pi-rpc-client"
import {
  useExternalAgentStore,
  type LifecycleExternalAgentConfig,
} from "@/stores/agent/external-agent-store"
import type {
  AcpPermissionMode,
  CreateExternalAgentInput,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"

/** i18n label key (under `externalAgent.settings`) for each permission mode. */
export const PERMISSION_MODE_LABEL_KEY: Record<AcpPermissionMode, string> = {
  default: "permissionDefault",
  acceptEdits: "permissionAcceptEdits",
  bypassPermissions: "permissionBypass",
  plan: "permissionPlan",
  dontAsk: "permissionDontAsk",
}

// =============================================================================
// Types
// =============================================================================

interface AgentFormData {
  cogniaModel?: CreateExternalAgentInput["cogniaModel"]
  name: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  // Process config (for stdio)
  processCommand: string
  processArgs: string
  processCwd: string
  // Network config (for http/websocket)
  networkEndpoint: string
  networkApiKey: string
  // Settings
  defaultPermissionMode: AcpPermissionMode
  /** Tri-state for `declaredCapabilities["web.search"]`; "" ≡ let us work it out. */
  declaredWebSearch: "" | "native" | "unsupported"
  description: string
  timeoutMs: string
  retryMaxRetries: string
  retryDelayMs: string
  retryExponentialBackoff: boolean
  retryMaxDelayMs: string
  retryOnErrors: string
  // Codex app-server options (shown only for protocol === "codex-app-server")
  codexSandboxMode: "readOnly" | "workspaceWrite" | "dangerFullAccess"
  codexNetworkAccess: boolean
  /** Empty string = model default */
  codexDefaultEffort: string
  /** Empty string = server default */
  codexReasoningSummary: "" | "auto" | "concise" | "detailed" | "none"
  /** Newline-separated absolute folders registered as extra Codex skill roots */
  codexExtraSkillRoots: string
  // OpenCode options (shown only for protocol === "opencode")
  opencodeAutoSpawn: boolean
  /** Empty string = let the server pick a free port (0) */
  opencodePort: string
  /** Empty string = 127.0.0.1 */
  opencodeHostname: string
  opencodeServerPassword: string
  /** Empty string = "opencode" (the server's Basic-Auth default user) */
  opencodeServerUsername: string
  /** Default model as "providerID/modelID"; empty = server default */
  opencodeModel: string
  // Pi native RPC options (shown only for protocol === "pi-rpc")
  /**
   * How much of the user's own Pi installation loads inside a Cognia session.
   * Defaults to global extensions so installed provider plugins supply the
   * same models as Pi itself. Project-local extensions still require trust.
   */
  piExtensionPolicy: PiExtensionPolicy
}

/** Split the newline-separated skill-roots textarea into clean, unique paths. */
function parseSkillRootLines(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of value.split("\n")) {
    const path = line.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

const DEFAULT_TIMEOUT_MS = "300000"
const DEFAULT_RETRY_MAX_RETRIES = "3"
const DEFAULT_RETRY_DELAY_MS = "1000"
const DEFAULT_RETRY_MAX_DELAY_MS = "30000"

/**
 * Read the stored declaration back into the tri-state. Only `native` and
 * `unsupported` are offered: `equivalent` has no meaning a person could supply
 * here, and `unknown` IS the empty option — so anything else reads as "work it out".
 */
export function declaredWebSearchOf(
  declared: LifecycleExternalAgentConfig["declaredCapabilities"]
): "" | "native" | "unsupported" {
  const level = declared?.["web.search"]
  return level === "native" || level === "unsupported" ? level : ""
}

const DEFAULT_FORM_DATA: AgentFormData = {
  name: "",
  protocol: "acp",
  transport: "stdio",
  processCommand: "",
  processArgs: "",
  processCwd: "",
  networkEndpoint: "",
  networkApiKey: "",
  defaultPermissionMode: "default",
  declaredWebSearch: "",
  description: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retryMaxRetries: DEFAULT_RETRY_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  retryExponentialBackoff: true,
  retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  retryOnErrors: "",
  codexSandboxMode: "workspaceWrite",
  codexNetworkAccess: false,
  codexDefaultEffort: "",
  codexReasoningSummary: "",
  codexExtraSkillRoots: "",
  opencodeAutoSpawn: false,
  opencodePort: "",
  opencodeHostname: "",
  opencodeServerPassword: "",
  opencodeServerUsername: "",
  opencodeModel: "",
  piExtensionPolicy: "global",
}

/**
 * Read the same policy used by the session and catalog probe.
 *
 * An unrecognised stored value falls back to `isolated` rather than being
 * trusted: a typo must not silently load the user's whole Pi extension stack
 * into a Cognia-run session.
 */
function piExtensionPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined
): PiExtensionPolicy {
  return resolvePiExtensionPolicy(metadata?.piExtensionPolicy)
}

/** Pull the OpenCode form fields out of an agent/preset `metadata` bag. */
function opencodeFieldsFromMetadata(
  metadata: Record<string, unknown> | undefined
): Pick<
  AgentFormData,
  | "opencodeAutoSpawn"
  | "opencodePort"
  | "opencodeHostname"
  | "opencodeServerPassword"
  | "opencodeServerUsername"
  | "opencodeModel"
> {
  return {
    opencodeAutoSpawn: metadata?.autoSpawnServer === true,
    opencodePort: typeof metadata?.port === "number" ? String(metadata.port) : "",
    opencodeHostname: typeof metadata?.hostname === "string" ? metadata.hostname : "",
    opencodeServerPassword:
      typeof metadata?.serverPassword === "string" ? metadata.serverPassword : "",
    opencodeServerUsername:
      typeof metadata?.serverUsername === "string" ? metadata.serverUsername : "",
    opencodeModel: typeof metadata?.model === "string" ? metadata.model : "",
  }
}

/** Static effort choices offered as per-agent defaults; the true per-model
 * list is session-level (from `model/list` supportedReasoningEfforts). */
const CODEX_EFFORT_CHOICES = ["minimal", "low", "medium", "high", "xhigh"] as const

// =============================================================================
// Connection Status Components
// =============================================================================

/**
 * Collapsible field group used to break the editor dialog's long single-column
 * form into scannable sections. `data-testid` sits on the always-mounted root
 * so tests can find a section even while its content is collapsed.
 */
function FormSection({
  title,
  summary,
  defaultOpen = false,
  dataTestId,
  children,
}: {
  title: string
  summary?: string
  defaultOpen?: boolean
  dataTestId?: string
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-lg border" data-testid={dataTestId}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="text-sm font-medium">{title}</span>
        <span className="flex min-w-0 items-center gap-2">
          {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 border-t px-3 py-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// =============================================================================
// Agent Editor Dialog
// =============================================================================

interface AgentEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingAgentId?: string | null
  /**
   * Optional preset id to seed the dialog with when opened from the
   * quick-start gallery. Empty string means "manual configuration".
   */
  initialPreset?: string
  onSave: (data: CreateExternalAgentInput) => void
}

export function AgentEditorDialog({
  open,
  onOpenChange,
  editingAgentId,
  initialPreset,
  onSave,
}: AgentEditorDialogProps) {
  const t = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tCommon = useTranslations("common")
  const tGateway = useTranslations("externalAgent.cogniaModel")
  const { getAgent } = useExternalAgentStore()

  // Quick-start preset selector — mirrors the chat-side AddAgentDialog pattern
  // in `components/agent/external-agent-manager.tsx`. Picking a preset fills
  // the form fields and stamps `metadata.preset` on save so `isFromPreset()`
  // can later badge the row.
  const [selectedPreset, setSelectedPreset] = useState<string>(
    initialPreset ||
      (editingAgentId ? String(getAgent(editingAgentId)?.metadata?.preset ?? "") : "")
  )
  // Both path affordances below are this device's filesystem: an external agent
  // spawns through a local process, so there is no host to browse instead.
  const directoryPicker = useDirectoryPicker()

  const [formData, setFormData] = useState<AgentFormData>(() => {
    // Quick-start gallery: open with the preset's defaults so the user only
    // has to tweak env vars / cwd before saving.
    if (!editingAgentId && initialPreset && initialPreset !== "custom") {
      const preset = getPresetConfig(initialPreset)
      if (preset) {
        return {
          ...DEFAULT_FORM_DATA,
          name: initialPreset === "opencode-v2-service" ? t("opencodeV2PresetName") : preset.name,
          protocol: preset.protocol,
          transport: preset.transport,
          processCommand: preset.process?.command ?? "",
          processArgs: preset.process?.args?.join(" ") ?? "",
          networkEndpoint: preset.network?.endpoint ?? "",
          defaultPermissionMode: preset.defaultPermissionMode,
          description:
            initialPreset === "opencode-v2-service"
              ? t("opencodeV2PresetDescription")
              : initialPreset === "devin"
                ? t("devinPresetDescription")
                : preset.description,
          ...opencodeFieldsFromMetadata(preset.metadata),
        }
      }
    }
    if (!editingAgentId) {
      return DEFAULT_FORM_DATA
    }

    const agent = getAgent(editingAgentId)
    if (!agent) {
      return DEFAULT_FORM_DATA
    }

    return {
      name: agent.name,
      cogniaModel: agent.cogniaModel,
      protocol: agent.protocol,
      transport: agent.transport,
      processCommand: agent.process?.command || "",
      processArgs: agent.process?.args?.join(" ") || "",
      processCwd: agent.process?.cwd || "",
      networkEndpoint: agent.network?.endpoint || "",
      networkApiKey: agent.network?.apiKey || "",
      defaultPermissionMode: agent.defaultPermissionMode || "default",
      declaredWebSearch: declaredWebSearchOf(agent.declaredCapabilities),
      description: agent.description || "",
      timeoutMs: String(agent.timeout ?? DEFAULT_TIMEOUT_MS),
      retryMaxRetries: String(agent.retryConfig?.maxRetries ?? DEFAULT_RETRY_MAX_RETRIES),
      retryDelayMs: String(agent.retryConfig?.retryDelay ?? DEFAULT_RETRY_DELAY_MS),
      retryExponentialBackoff: agent.retryConfig?.exponentialBackoff ?? true,
      retryMaxDelayMs: String(agent.retryConfig?.maxRetryDelay ?? DEFAULT_RETRY_MAX_DELAY_MS),
      retryOnErrors: agent.retryConfig?.retryOnErrors?.join(", ") || "",
      codexSandboxMode: agent.codexOptions?.sandboxMode ?? "workspaceWrite",
      codexNetworkAccess: agent.codexOptions?.networkAccess ?? false,
      codexDefaultEffort: agent.codexOptions?.defaultReasoningEffort ?? "",
      codexReasoningSummary: agent.codexOptions?.reasoningSummary ?? "",
      codexExtraSkillRoots: agent.codexOptions?.extraSkillRoots?.join("\n") ?? "",
      ...opencodeFieldsFromMetadata(agent.metadata),
      piExtensionPolicy: piExtensionPolicyFromMetadata(agent.metadata),
    }
  })

  const managedDsh = getPresetConfig(selectedPreset)?.metadata?.requiresManagedRuntime === true

  const handleSave = useCallback(() => {
    const toNonNegativeInteger = (value: string, fallback: number): number => {
      const parsed = Number.parseInt(value, 10)
      if (Number.isNaN(parsed) || parsed < 0) {
        return fallback
      }
      return parsed
    }

    const retryOnErrors = formData.retryOnErrors
      .split(/\r?\n|,/)
      .map((pattern) => pattern.trim())
      .filter(Boolean)

    if (!formData.name.trim()) {
      toast.error(t("nameRequired"))
      return
    }

    const input: CreateExternalAgentInput = {
      name: formData.name.trim(),
      cogniaModel: formData.cogniaModel ?? null,
      protocol: formData.protocol,
      transport: formData.transport,
      description: formData.description,
      defaultPermissionMode: formData.defaultPermissionMode,
      timeout: toNonNegativeInteger(formData.timeoutMs, Number.parseInt(DEFAULT_TIMEOUT_MS, 10)),
      retryConfig: {
        maxRetries: toNonNegativeInteger(
          formData.retryMaxRetries,
          Number.parseInt(DEFAULT_RETRY_MAX_RETRIES, 10)
        ),
        retryDelay: toNonNegativeInteger(
          formData.retryDelayMs,
          Number.parseInt(DEFAULT_RETRY_DELAY_MS, 10)
        ),
        exponentialBackoff: formData.retryExponentialBackoff,
        maxRetryDelay: toNonNegativeInteger(
          formData.retryMaxDelayMs,
          Number.parseInt(DEFAULT_RETRY_MAX_DELAY_MS, 10)
        ),
        retryOnErrors,
      },
    }

    const selectedPresetConfig =
      selectedPreset && selectedPreset !== "custom" ? getPresetConfig(selectedPreset) : null

    if (formData.protocol === "opencode-v2") {
      const endpoint = formData.networkEndpoint.trim()
      if (endpoint) {
        let validEndpoint = false
        try {
          validEndpoint = ["http:", "https:"].includes(new URL(endpoint).protocol)
        } catch {
          // An explicit endpoint must be absolute; empty uses local discovery.
        }
        if (!validEndpoint) {
          toast.error(t("endpointInvalid"))
          return
        }
      }
      // Explicit empty values also clear a saved endpoint/workspace on edit.
      input.network = {
        endpoint,
        apiKey: formData.networkApiKey || undefined,
      }
      input.process = { command: "", args: [], cwd: formData.processCwd.trim() || undefined }
    } else if (formData.protocol === "opencode") {
      // OpenCode auto-spawns a local `opencode serve` when the toggle is on
      // (seeded from the preset); otherwise it connects to a server endpoint.
      if (formData.opencodeAutoSpawn) {
        input.process = {
          command: formData.processCommand.trim() || "opencode",
          args: formData.processArgs.split(" ").filter(Boolean),
          cwd: formData.processCwd || undefined,
        }
      } else {
        if (!formData.networkEndpoint.trim()) {
          toast.error(t("endpointRequired"))
          return
        }
        input.network = {
          endpoint: formData.networkEndpoint.trim(),
          apiKey: formData.networkApiKey || undefined,
        }
      }
    } else if (formData.transport === "stdio") {
      if (!managedDsh && !formData.processCommand.trim()) {
        toast.error(t("commandRequired"))
        return
      }
      input.process = {
        command: managedDsh ? "" : formData.processCommand.trim(),
        args: managedDsh ? [] : formData.processArgs.split(" ").filter(Boolean),
        cwd: formData.processCwd || undefined,
        ...(managedDsh && formData.networkApiKey
          ? { env: { DEEPSEEK_API_KEY: formData.networkApiKey } }
          : {}),
      }
    } else {
      if (!formData.networkEndpoint.trim()) {
        toast.error(t("endpointRequired"))
        return
      }
      input.network = {
        endpoint: formData.networkEndpoint.trim(),
        apiKey: formData.networkApiKey || undefined,
      }
    }

    if (formData.protocol === "codex-app-server") {
      input.codexOptions = {
        sandboxMode: formData.codexSandboxMode,
        ...(formData.codexSandboxMode !== "dangerFullAccess"
          ? { networkAccess: formData.codexNetworkAccess }
          : {}),
        ...(formData.codexDefaultEffort
          ? { defaultReasoningEffort: formData.codexDefaultEffort }
          : {}),
        ...(formData.codexReasoningSummary
          ? { reasoningSummary: formData.codexReasoningSummary }
          : {}),
        ...(parseSkillRootLines(formData.codexExtraSkillRoots).length
          ? { extraSkillRoots: parseSkillRootLines(formData.codexExtraSkillRoots) }
          : {}),
      }
    }

    // The user's own statement about this build (merge layer `user-declared`).
    // An absent declaration and a declaration of "unknown" are the same thing,
    // so "work it out" writes the EMPTY object rather than omitting the key:
    // every write below this is a partial update, where an omitted key means
    // "leave it alone" — which on an edit would pin the previous answer with no
    // way back to it. `{}` is the clear, honoured by `updateAgent` and by
    // `normalizeExternalAgentConfigInput`.
    input.declaredCapabilities = formData.declaredWebSearch
      ? { "web.search": formData.declaredWebSearch }
      : {}

    if (selectedPresetConfig) {
      input.metadata = {
        preset: selectedPreset,
        ecosystemAdapterId: selectedPresetConfig.adapterId,
        ecosystemSurfaceId: selectedPresetConfig.surfaceId,
        ecosystemSupportTier: selectedPresetConfig.supportTier,
        ecosystemDocsUrl: selectedPresetConfig.docsUrl,
        ...selectedPresetConfig.metadata,
      }
    }

    if (formData.protocol === "opencode") {
      // The adapter reads all of these off `metadata` (resolveBaseUrl /
      // buildAuthHeaders / resolveModel) — write what the user set, and
      // override any preset-carried defaults with the form values.
      const opencodeMetadata: Record<string, unknown> = {
        ...(input.metadata ?? {}),
        autoSpawnServer: formData.opencodeAutoSpawn,
      }
      const port = Number.parseInt(formData.opencodePort, 10)
      if (!Number.isNaN(port) && port >= 0) opencodeMetadata.port = port
      else delete opencodeMetadata.port
      if (formData.opencodeHostname.trim()) {
        opencodeMetadata.hostname = formData.opencodeHostname.trim()
      } else delete opencodeMetadata.hostname
      if (formData.opencodeServerPassword) {
        opencodeMetadata.serverPassword = formData.opencodeServerPassword
      } else delete opencodeMetadata.serverPassword
      if (formData.opencodeServerUsername.trim()) {
        opencodeMetadata.serverUsername = formData.opencodeServerUsername.trim()
      } else delete opencodeMetadata.serverUsername
      if (formData.opencodeModel.trim()) {
        opencodeMetadata.model = formData.opencodeModel.trim()
      } else delete opencodeMetadata.model
      input.metadata = opencodeMetadata
    }

    if (formData.protocol === "opencode-v2") {
      // Metadata updates merge with saved values; null explicitly clears auth.
      input.metadata = {
        ...(input.metadata ?? {}),
        serverPassword: formData.opencodeServerPassword || null,
        serverUsername: formData.opencodeServerUsername.trim() || null,
      }
    }

    if (formData.protocol === "pi-rpc") {
      // The adapter reads this off `metadata` when building spawn args, so it
      // must survive an edit that started from a preset (which supplies its
      // own metadata bag above).
      input.metadata = {
        ...(input.metadata ?? {}),
        piExtensionPolicy: formData.piExtensionPolicy,
      }
    }

    if (
      input.cogniaModel &&
      (!input.cogniaModel.providerId || !input.cogniaModel.modelId || !canUseCogniaModels(input))
    ) {
      toast.error(tGateway("invalid"))
      return
    }
    onSave(input)
    onOpenChange(false)
    setFormData(DEFAULT_FORM_DATA)
    setSelectedPreset("")
  }, [formData, selectedPreset, managedDsh, onSave, onOpenChange, t, tGateway])

  // Preset picker — keep tightly aligned with the chat-side AddAgentDialog
  // pattern. When a real preset is chosen, prefill the form fields so the user
  // only edits the truly variable bits (cwd, env keys). Choosing "" or
  // "custom" leaves the form alone.
  const handlePresetChange = useCallback(
    (presetId: string) => {
      setSelectedPreset(presetId)
      if (!presetId || presetId === "custom") return
      const preset = getPresetConfig(presetId)
      if (!preset) return
      setFormData((current) => ({
        ...current,
        name: presetId === "opencode-v2-service" ? t("opencodeV2PresetName") : preset.name,
        protocol: preset.protocol,
        transport: preset.transport,
        processCommand: preset.process?.command || current.processCommand,
        processArgs: preset.process?.args?.join(" ") || current.processArgs,
        networkEndpoint: preset.network?.endpoint || current.networkEndpoint,
        defaultPermissionMode: preset.defaultPermissionMode,
        description:
          presetId === "opencode-v2-service"
            ? t("opencodeV2PresetDescription")
            : presetId === "devin"
              ? t("devinPresetDescription")
              : preset.description,
        ...opencodeFieldsFromMetadata(preset.metadata),
      }))
    },
    [setFormData, t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[560px]">
        <DialogHeader className="shrink-0">
          <DialogTitle>{editingAgentId ? t("editAgent") : t("addAgent")}</DialogTitle>
          <DialogDescription>{t("agentConfigDescription")}</DialogDescription>
        </DialogHeader>

        <div className="-mx-1 grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-1 py-3">
          {/* Quick start preset — only shown when creating, not when editing,
              to avoid silently overwriting hand-tuned fields. */}
          {!editingAgentId && (
            <div className="grid gap-2" data-testid="preset-picker">
              <Label>{t("quickStartPreset")}</Label>
              <Select value={selectedPreset || "custom"} onValueChange={handlePresetChange}>
                <SelectTrigger>
                  <SelectValue placeholder={t("selectPresetOrCustom")} />
                </SelectTrigger>
                <SelectContent>
                  {getRunnablePresets().map((presetId) => {
                    const preset = getPresetConfig(presetId)
                    if (!preset) return null
                    return (
                      <SelectItem key={presetId} value={presetId}>
                        <div className="flex items-center gap-2">
                          <span>
                            {presetId === "opencode-v2-service"
                              ? t("opencodeV2PresetName")
                              : preset.name}
                          </span>
                          {(preset.tags?.length ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground">
                              ({preset.tags!.slice(0, 3).join(", ")})
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    )
                  })}
                  <SelectItem value="custom">{t("customConfiguration")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Name */}
          <div className="grid gap-2">
            <Label htmlFor="name">{t("agentName")}</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={t("agentNamePlaceholder")}
            />
          </div>

          {/* Protocol + transport share a row — they are one decision in
              practice, and pairing them halves the dialog's vertical budget.
              OpenCode owns its transport (HTTP+SSE), so the picker is hidden
              there instead of offering a choice the adapter ignores. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>{t("protocol")}</Label>
              <Select
                value={formData.protocol}
                onValueChange={(v) => {
                  const protocol = v as AgentFormData["protocol"]
                  setFormData({
                    ...formData,
                    protocol,
                    // The Codex app-server is a locally spawned JSON-RPC process;
                    // it has no network transport to fall back on.
                    transport:
                      protocol === "codex-app-server"
                        ? "stdio"
                        : protocol === "opencode" || protocol === "opencode-v2"
                          ? "sse"
                          : formData.transport,
                  })
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {externalProtocolOptions(formData.protocol).map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={!option.selectable}
                    >
                      {option.value === "opencode-v2" ? t("opencodeV2Protocol") : option.label}
                      {option.reasonKey ? ` — ${tManager(option.reasonKey)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {formData.protocol !== "opencode" && formData.protocol !== "opencode-v2" && (
              <div className="grid gap-2">
                <Label>{t("transport")}</Label>
                <Select
                  value={formData.transport}
                  onValueChange={(v) =>
                    setFormData({ ...formData, transport: v as AgentFormData["transport"] })
                  }
                  disabled={managedDsh || formData.protocol === "codex-app-server"}
                >
                  <SelectTrigger data-testid="transport-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">
                      <div className="flex items-center gap-2">
                        <Terminal className="h-4 w-4" />
                        <span>{t("transportStdioLabel")}</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="http">
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4" />
                        <span>{t("transportHttpLabel")}</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* OpenCode server config — auto-spawn vs remote endpoint, plus the
              auth/model metadata the adapter reads (resolveBaseUrl /
              buildAuthHeaders / resolveModel). Mirrors the chat-side dialog in
              components/agent/external-agent/manager.tsx. */}
          {formData.protocol === "opencode" && (
            <FormSection
              title={t("sectionOpencodeServer")}
              defaultOpen
              dataTestId="opencode-options-section"
            >
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="opencode-auto-spawn" className="cursor-pointer text-sm">
                    {tManager("autoSpawnServer")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{tManager("autoSpawnServerHint")}</p>
                </div>
                <Switch
                  id="opencode-auto-spawn"
                  checked={formData.opencodeAutoSpawn}
                  onCheckedChange={(v) => setFormData({ ...formData, opencodeAutoSpawn: v })}
                  aria-label={tManager("autoSpawnServer")}
                />
              </div>
              {formData.opencodeAutoSpawn ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="opencode-command">{t("command")}</Label>
                    <Input
                      id="opencode-command"
                      value={formData.processCommand}
                      onChange={(e) => setFormData({ ...formData, processCommand: e.target.value })}
                      // i18n-exempt: example CLI command, not UI prose
                      placeholder="opencode"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="opencode-port">{tManager("serverPort")}</Label>
                      <Input
                        id="opencode-port"
                        type="number"
                        min={0}
                        value={formData.opencodePort}
                        onChange={(e) => setFormData({ ...formData, opencodePort: e.target.value })}
                        placeholder="0"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="opencode-hostname">{tManager("serverHostname")}</Label>
                      <Input
                        id="opencode-hostname"
                        value={formData.opencodeHostname}
                        onChange={(e) =>
                          setFormData({ ...formData, opencodeHostname: e.target.value })
                        }
                        // i18n-exempt: example hostname, not UI prose
                        placeholder="127.0.0.1"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="opencode-endpoint">{t("endpoint")}</Label>
                  <Input
                    id="opencode-endpoint"
                    value={formData.networkEndpoint}
                    onChange={(e) => setFormData({ ...formData, networkEndpoint: e.target.value })}
                    // i18n-exempt: example URL, not UI prose
                    placeholder="http://127.0.0.1:4096"
                  />
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="opencode-server-password">{tManager("serverPassword")}</Label>
                  <Input
                    id="opencode-server-password"
                    type="password"
                    value={formData.opencodeServerPassword}
                    onChange={(e) =>
                      setFormData({ ...formData, opencodeServerPassword: e.target.value })
                    }
                    placeholder="••••••••"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="opencode-server-username">{tManager("serverUsername")}</Label>
                  <Input
                    id="opencode-server-username"
                    value={formData.opencodeServerUsername}
                    onChange={(e) =>
                      setFormData({ ...formData, opencodeServerUsername: e.target.value })
                    }
                    // i18n-exempt: the server's documented default Basic-Auth user
                    placeholder="opencode"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{tManager("serverPasswordHint")}</p>
              <div className="grid gap-2">
                <Label htmlFor="opencode-model">{tManager("defaultModel")}</Label>
                <Input
                  id="opencode-model"
                  value={formData.opencodeModel}
                  onChange={(e) => setFormData({ ...formData, opencodeModel: e.target.value })}
                  // i18n-exempt: example provider/model id, not UI prose
                  placeholder="anthropic/claude-sonnet-4-5"
                />
                <p className="text-xs text-muted-foreground">{tManager("defaultModelHint")}</p>
              </div>
            </FormSection>
          )}

          {formData.protocol === "opencode-v2" && (
            <FormSection
              title={t("sectionConnection")}
              defaultOpen
              dataTestId="opencode-v2-options-section"
            >
              <p className="text-xs text-muted-foreground">{t("opencodeV2PresetSetupHint")}</p>
              <div className="grid gap-2">
                <Label htmlFor="opencode-v2-endpoint">{t("endpoint")}</Label>
                <Input
                  id="opencode-v2-endpoint"
                  value={formData.networkEndpoint}
                  onChange={(e) => setFormData({ ...formData, networkEndpoint: e.target.value })}
                  placeholder={t("opencodeV2EndpointPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">{t("opencodeV2EndpointHint")}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="opencode-v2-server-password">{tManager("serverPassword")}</Label>
                  <Input
                    id="opencode-v2-server-password"
                    type="password"
                    value={formData.opencodeServerPassword}
                    onChange={(e) =>
                      setFormData({ ...formData, opencodeServerPassword: e.target.value })
                    }
                    placeholder="••••••••"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="opencode-v2-server-username">{tManager("serverUsername")}</Label>
                  <Input
                    id="opencode-v2-server-username"
                    value={formData.opencodeServerUsername}
                    onChange={(e) =>
                      setFormData({ ...formData, opencodeServerUsername: e.target.value })
                    }
                    // i18n-exempt: the native service's default Basic-Auth username
                    placeholder="opencode"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="opencode-v2-api-key">{t("apiKey")}</Label>
                <Input
                  id="opencode-v2-api-key"
                  type="password"
                  value={formData.networkApiKey}
                  onChange={(e) => setFormData({ ...formData, networkApiKey: e.target.value })}
                  placeholder={t("apiKeyPlaceholder")}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="opencode-v2-cwd">{t("workingDirectory")}</Label>
                <Input
                  id="opencode-v2-cwd"
                  value={formData.processCwd}
                  onChange={(e) => setFormData({ ...formData, processCwd: e.target.value })}
                  placeholder={t("cwdPlaceholder")}
                />
              </div>
            </FormSection>
          )}

          {/* Connection — stdio process args or the network endpoint, whichever
              the chosen transport actually uses. */}
          {formData.protocol !== "opencode" && formData.protocol !== "opencode-v2" && (
            <FormSection
              title={t("sectionConnection")}
              defaultOpen
              dataTestId="connection-section"
              summary={
                formData.transport === "stdio"
                  ? formData.processCommand || undefined
                  : formData.networkEndpoint || undefined
              }
            >
              {formData.transport === "stdio" ? (
                <>
                  {managedDsh && (
                    <div className="grid gap-2">
                      <p className="text-xs text-muted-foreground">
                        {t("deepseekHarness.managedLaunchNotice")}
                      </p>
                      <Label htmlFor="dsh-api-key">{t("apiKey")}</Label>
                      <Input
                        id="dsh-api-key"
                        type="password"
                        autoComplete="new-password"
                        value={formData.networkApiKey}
                        onChange={(event) =>
                          setFormData({ ...formData, networkApiKey: event.target.value })
                        }
                        placeholder={t("apiKeyPlaceholder")}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("deepseekHarness.credentialNotice")}
                      </p>
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label htmlFor="command">{t("command")}</Label>
                    <Input
                      id="command"
                      disabled={managedDsh}
                      value={formData.processCommand}
                      onChange={(e) => setFormData({ ...formData, processCommand: e.target.value })}
                      // i18n-exempt: example CLI command, not UI prose
                      placeholder="npx @anthropics/claude-code"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="args">{t("arguments")}</Label>
                    <Input
                      id="args"
                      disabled={managedDsh}
                      value={formData.processArgs}
                      onChange={(e) => setFormData({ ...formData, processArgs: e.target.value })}
                      // i18n-exempt: example CLI arguments, not UI prose
                      placeholder="--stdio --model claude-sonnet"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="cwd">{t("workingDirectory")}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="cwd"
                        value={formData.processCwd}
                        onChange={(e) => setFormData({ ...formData, processCwd: e.target.value })}
                        placeholder={t("cwdPlaceholder")}
                      />
                      {/* The path is this device's: an external agent spawns
                          through a local process, so there is nothing to
                          browse without a native picker and the input is the
                          control. The button used to render regardless and do
                          nothing at all when clicked. */}
                      {directoryPicker.available && (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={t("codexSkillRootsBrowse")}
                          data-testid="cwd-browse"
                          disabled={directoryPicker.busy}
                          onClick={async () => {
                            const dir = await directoryPicker.browse()
                            if (dir) setFormData((prev) => ({ ...prev, processCwd: dir }))
                          }}
                        >
                          <FolderPlus className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="endpoint">{t("endpoint")}</Label>
                    <Input
                      id="endpoint"
                      value={formData.networkEndpoint}
                      onChange={(e) =>
                        setFormData({ ...formData, networkEndpoint: e.target.value })
                      }
                      placeholder="https://api.example.com/agent"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="apiKey">{t("apiKey")}</Label>
                    <Input
                      id="apiKey"
                      type="password"
                      value={formData.networkApiKey}
                      onChange={(e) => setFormData({ ...formData, networkApiKey: e.target.value })}
                      placeholder={t("apiKeyPlaceholder")}
                    />
                  </div>
                </>
              )}
            </FormSection>
          )}

          <CogniaModelPicker
            config={{
              protocol: formData.protocol,
              transport: formData.transport,
              process: {
                command: formData.processCommand || (formData.opencodeAutoSpawn ? "opencode" : ""),
                args: formData.processArgs.split(" ").filter(Boolean),
              },
              network:
                formData.transport !== "stdio" && !formData.opencodeAutoSpawn
                  ? { endpoint: formData.networkEndpoint }
                  : undefined,
              metadata: {
                ...(selectedPreset
                  ? getPresetConfig(selectedPreset)?.metadata
                  : editingAgentId
                    ? getAgent(editingAgentId)?.metadata
                    : {}),
                preset: selectedPreset || undefined,
                autoSpawnServer: formData.opencodeAutoSpawn,
              },
            }}
            value={formData.cogniaModel}
            onChange={(cogniaModel) => setFormData((current) => ({ ...current, cogniaModel }))}
          />

          {/* Permission Mode — narrowed to the modes the chosen backend can
              enforce, and clamped for display so switching protocol never shows
              a mode the backend would silently downgrade. */}
          <div className="grid gap-2">
            <Label>{t("defaultPermissionMode")}</Label>
            <Select
              value={adaptPermissionMode(formData.defaultPermissionMode, formData.protocol).mode}
              onValueChange={(v) =>
                setFormData({ ...formData, defaultPermissionMode: v as AcpPermissionMode })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supportedPermissionModes(formData.protocol).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(PERMISSION_MODE_LABEL_KEY[mode])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Does this build reach the web on its own?
              Nothing in the wire protocol answers it — it is a property of the
              binary and plan the user installed — so every manifest row ships
              `unknown` and this is where it stops being unknown. It decides
              whether Cognia supplies `web_search` for the turn
              (`lib/chat/web-access.ts`). */}
          <div className="grid gap-2">
            <Label>{t("declaredWebSearch")}</Label>
            <p className="text-sm text-muted-foreground">{t("declaredWebSearchDesc")}</p>
            <Select
              value={formData.declaredWebSearch || "auto"}
              onValueChange={(v) =>
                setFormData({
                  ...formData,
                  declaredWebSearch: v === "auto" ? "" : (v as "native" | "unsupported"),
                })
              }
            >
              <SelectTrigger data-testid="declared-web-search">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("declaredWebSearchAuto")}</SelectItem>
                <SelectItem value="native">{t("declaredWebSearchNative")}</SelectItem>
                <SelectItem value="unsupported">{t("declaredWebSearchNone")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Codex app-server options — sandbox + reasoning defaults applied at
              thread/start (sandbox) and turn/start (sandboxPolicy/effort/summary).
              Session-level overrides remain available via config options. */}
          {formData.protocol === "codex-app-server" && (
            <FormSection
              title={t("sectionCodexOptions")}
              defaultOpen
              dataTestId="codex-options-section"
            >
              <div className="grid gap-2">
                <Label>{t("codexSandboxMode")}</Label>
                <p className="text-sm text-muted-foreground">{t("codexSandboxModeDesc")}</p>
                <Select
                  value={formData.codexSandboxMode}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      codexSandboxMode: v as AgentFormData["codexSandboxMode"],
                    })
                  }
                >
                  <SelectTrigger data-testid="codex-sandbox-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="readOnly">{t("codexSandboxReadOnly")}</SelectItem>
                    <SelectItem value="workspaceWrite">
                      {t("codexSandboxWorkspaceWrite")}
                    </SelectItem>
                    <SelectItem value="dangerFullAccess">
                      {t("codexSandboxDangerFullAccess")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {formData.codexSandboxMode !== "dangerFullAccess" && (
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="codexNetworkAccess">{t("codexNetworkAccess")}</Label>
                    <p className="text-sm text-muted-foreground">{t("codexNetworkAccessDesc")}</p>
                  </div>
                  <Switch
                    id="codexNetworkAccess"
                    checked={formData.codexNetworkAccess}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, codexNetworkAccess: checked })
                    }
                  />
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>{t("codexDefaultEffort")}</Label>
                  <Select
                    value={formData.codexDefaultEffort || "model-default"}
                    onValueChange={(v) =>
                      setFormData({
                        ...formData,
                        codexDefaultEffort: v === "model-default" ? "" : v,
                      })
                    }
                  >
                    <SelectTrigger data-testid="codex-default-effort">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="model-default">{t("codexModelDefault")}</SelectItem>
                      {CODEX_EFFORT_CHOICES.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>{t("codexReasoningSummary")}</Label>
                  <Select
                    value={formData.codexReasoningSummary || "server-default"}
                    onValueChange={(v) =>
                      setFormData({
                        ...formData,
                        codexReasoningSummary: (v === "server-default"
                          ? ""
                          : v) as AgentFormData["codexReasoningSummary"],
                      })
                    }
                  >
                    <SelectTrigger data-testid="codex-reasoning-summary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server-default">{t("codexServerDefault")}</SelectItem>
                      <SelectItem value="auto">{t("codexSummaryAuto")}</SelectItem>
                      <SelectItem value="concise">{t("codexSummaryConcise")}</SelectItem>
                      <SelectItem value="detailed">{t("codexSummaryDetailed")}</SelectItem>
                      <SelectItem value="none">{t("codexSummaryNone")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="codexExtraSkillRoots">{t("codexExtraSkillRoots")}</Label>
                  {/* Same reasoning as the working-directory button above: the
                      textarea beside it is the control on a shell with no
                      picker, and this used to render inert. */}
                  {directoryPicker.available && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="codex-skill-roots-browse"
                      disabled={directoryPicker.busy}
                      onClick={async () => {
                        const dir = await directoryPicker.browse()
                        if (!dir) return
                        setFormData((prev) => {
                          const roots = parseSkillRootLines(prev.codexExtraSkillRoots)
                          if (roots.includes(dir)) return prev
                          return { ...prev, codexExtraSkillRoots: [...roots, dir].join("\n") }
                        })
                      }}
                    >
                      <FolderPlus className="h-4 w-4" />
                      {t("codexSkillRootsBrowse")}
                    </Button>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{t("codexExtraSkillRootsDesc")}</p>
                <Textarea
                  id="codexExtraSkillRoots"
                  data-testid="codex-skill-roots"
                  value={formData.codexExtraSkillRoots}
                  onChange={(e) =>
                    setFormData({ ...formData, codexExtraSkillRoots: e.target.value })
                  }
                  placeholder={t("codexExtraSkillRootsPlaceholder")}
                  rows={3}
                  className="font-mono text-xs"
                />
              </div>
            </FormSection>
          )}

          {formData.protocol === "pi-rpc" && (
            <FormSection title={t("piSectionTitle")} defaultOpen dataTestId="pi-options-section">
              <div className="space-y-2">
                <Label htmlFor="pi-extension-policy">{t("piExtensionPolicyLabel")}</Label>
                <Select
                  value={formData.piExtensionPolicy}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      piExtensionPolicy: v as PiExtensionPolicy,
                    })
                  }
                >
                  <SelectTrigger id="pi-extension-policy" data-testid="pi-extension-policy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="isolated">{t("piExtensionPolicyIsolated")}</SelectItem>
                    <SelectItem value="global">{t("piExtensionPolicyGlobal")}</SelectItem>
                    <SelectItem value="trusted-project">
                      {t("piExtensionPolicyTrustedProject")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {formData.piExtensionPolicy === "trusted-project"
                    ? t("piExtensionPolicyTrustedProjectWarning")
                    : t("piExtensionPolicyHint")}
                </p>
                {/* The exact flags, so the isolation claim is inspectable
                    rather than something the user has to take on trust. */}
                <p className="text-muted-foreground font-mono text-[11px]">
                  {extensionPolicyArgs(formData.piExtensionPolicy).join(" ")}
                </p>
              </div>
              <p className="text-muted-foreground text-xs">{t("piSandboxNote")}</p>
              {/* The policy above decides how much of the user's Pi extension
                  stack loads; this is where they can see and change what that
                  stack actually contains, and what it costs per turn. */}
              <Button asChild variant="outline" size="sm" className="w-fit">
                <Link href={piPackagesHref()} data-testid="pi-packages-link">
                  <PackageIcon className="size-3.5" />
                  {t("piManagePackages")}
                </Link>
              </Button>
            </FormSection>
          )}

          {/* Timeout & retry — tuning knobs almost nobody changes, so they stay
              folded away behind a summary of the values currently in effect. */}
          <FormSection
            title={t("sectionRetry")}
            dataTestId="retry-section"
            summary={t("sectionRetrySummary", {
              timeout: Math.round((Number.parseInt(formData.timeoutMs, 10) || 0) / 1000),
              retries: Number.parseInt(formData.retryMaxRetries, 10) || 0,
            })}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="timeoutMs">{t("executionTimeoutMs")}</Label>
                <Input
                  id="timeoutMs"
                  type="number"
                  min={1000}
                  step={1000}
                  value={formData.timeoutMs}
                  onChange={(e) => setFormData({ ...formData, timeoutMs: e.target.value })}
                  placeholder={DEFAULT_TIMEOUT_MS}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="retryMaxRetries">{t("maxRetries")}</Label>
                <Input
                  id="retryMaxRetries"
                  type="number"
                  min={0}
                  step={1}
                  value={formData.retryMaxRetries}
                  onChange={(e) => setFormData({ ...formData, retryMaxRetries: e.target.value })}
                  placeholder={DEFAULT_RETRY_MAX_RETRIES}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="retryDelayMs">{t("retryDelayMs")}</Label>
                <Input
                  id="retryDelayMs"
                  type="number"
                  min={0}
                  step={100}
                  value={formData.retryDelayMs}
                  onChange={(e) => setFormData({ ...formData, retryDelayMs: e.target.value })}
                  placeholder={DEFAULT_RETRY_DELAY_MS}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="retryMaxDelayMs">{t("maxRetryDelayMs")}</Label>
                <Input
                  id="retryMaxDelayMs"
                  type="number"
                  min={0}
                  step={100}
                  value={formData.retryMaxDelayMs}
                  onChange={(e) => setFormData({ ...formData, retryMaxDelayMs: e.target.value })}
                  placeholder={DEFAULT_RETRY_MAX_DELAY_MS}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="retryExponentialBackoff">{t("backoffStrategy")}</Label>
              <Select
                value={formData.retryExponentialBackoff ? "true" : "false"}
                onValueChange={(value) =>
                  setFormData({ ...formData, retryExponentialBackoff: value === "true" })
                }
              >
                <SelectTrigger id="retryExponentialBackoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{t("backoffExponential")}</SelectItem>
                  <SelectItem value="false">{t("backoffFixedDelay")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="retryOnErrors">{t("retryErrorPatterns")}</Label>
              <Textarea
                id="retryOnErrors"
                rows={2}
                value={formData.retryOnErrors}
                onChange={(e) => setFormData({ ...formData, retryOnErrors: e.target.value })}
                placeholder={t("retryErrorPatternsPlaceholder")}
              />
            </div>
          </FormSection>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSave}>{editingAgentId ? tCommon("save") : tCommon("add")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
