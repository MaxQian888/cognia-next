"use client"

/**
 * ExternalAgentSettings - Settings component for managing external agents
 * Provides UI for configuring external agents, connection settings, and delegation rules
 */

import { useState, useCallback, useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Plus,
  Trash2,
  Edit,
  Power,
  PowerOff,
  ExternalLink,
  Plug,
  PlugZap,
  AlertCircle,
  Loader2,
  Terminal,
  Globe,
  FolderPlus,
  ChevronDown,
  Settings2,
  Sparkles,
  Route,
  PackageIcon,
  Boxes,
  ServerCog,
} from "lucide-react"
import Link from "next/link"
import { piPackagesHref } from "@/lib/pi-packages/deep-link"
import { externalProtocolOptions } from "@/lib/ai/agent/external/protocol-options"
import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { externalAgentSandboxSupportsPlatform } from "@/lib/ai/agent/external/security-policy"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { RuntimeGovernancePanel } from "@/components/agent/external-agent/runtime-governance-panel"
import { HostExternalAgentConfigs } from "./host-external-agent-configs"
import { UnsandboxedConsentAction } from "@/components/agent/external-agent/unsandboxed-consent-action"
import { UnsandboxedStatusBadge } from "@/components/agent/external-agent/unsandboxed-status-badge"
import { isTauri } from "@/lib/tauri"
import { platform as tauriPlatform } from "@tauri-apps/plugin-os"
import { cn } from "@/lib/utils"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { BrandIcon } from "@/components/icons/brand-icon"
import {
  useExternalAgentStore,
  type LifecycleExternalAgentConfig,
} from "@/stores/agent/external-agent-store"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import { DelegationRulesSection } from "./delegation-rules-section"
import { DeepSeekHarnessCard } from "./deepseek-harness-card"
import { CodexAppServerStatusCard } from "./codex-app-server-status-card"
import { OpencodeStatusCard } from "./opencode-status-card"
import { PiAuthStatusCard } from "./pi-auth-status-card"
import {
  getExternalAgentEcosystemReadiness,
  getExternalAgentExecutionBlockReason,
} from "@/lib/ai/agent/external/config-normalizer"
import {
  getAvailablePresets,
  getPresetConfig,
  getPresetDisplayInfo,
  getRunnablePresets,
  isFromPreset,
  resolvePreferredCodexExecutablePresetId,
} from "@/lib/ai/agent/external/presets"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/permission-modes"
import { extensionPolicyArgs, type PiExtensionPolicy } from "@/lib/ai/agent/external/pi-rpc-client"
import type { AcpPreviewFeature } from "@/lib/ai/agent/external/acp-feature-profile"
import type {
  ExternalAgentConnectionStatus,
  CreateExternalAgentInput,
  UpdateExternalAgentInput,
  AcpPermissionMode,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"

/** i18n label key (under `externalAgent.settings`) for each permission mode. */
const PERMISSION_MODE_LABEL_KEY: Record<AcpPermissionMode, string> = {
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
   * Defaults to `isolated` because community permission extensions also hook
   * `tool_call`, and two engines intercepting one call produce double prompts
   * and unpredictable blocking.
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
function declaredWebSearchOf(
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
  piExtensionPolicy: "isolated",
}

/**
 * Read the Pi extension policy off `metadata`, defaulting to the safe end.
 *
 * An unrecognised stored value falls back to `isolated` rather than being
 * trusted: a typo must not silently load the user's whole Pi extension stack
 * into a Cognia-run session.
 */
function piExtensionPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined
): PiExtensionPolicy {
  const value = metadata?.piExtensionPolicy
  return value === "global" || value === "trusted-project" ? value : "isolated"
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

function ConnectionStatusIcon({ status }: { status: ExternalAgentConnectionStatus }) {
  switch (status) {
    case "connected":
      return <PlugZap className="h-4 w-4 text-green-500" />
    case "connecting":
    case "reconnecting":
      return <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />
    case "error":
      return <AlertCircle className="h-4 w-4 text-destructive" />
    default:
      return <Plug className="h-4 w-4 text-muted-foreground" />
  }
}

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

function AgentEditorDialog({
  open,
  onOpenChange,
  editingAgentId,
  initialPreset,
  onSave,
}: AgentEditorDialogProps) {
  const t = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tCommon = useTranslations("common")
  const { getAgent } = useExternalAgentStore()

  // Quick-start preset selector — mirrors the chat-side AddAgentDialog pattern
  // in `components/agent/external-agent-manager.tsx`. Picking a preset fills
  // the form fields and stamps `metadata.preset` on save so `isFromPreset()`
  // can later badge the row.
  const [selectedPreset, setSelectedPreset] = useState<string>(initialPreset ?? "")
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
          name: initialPreset === "opencode-v2-preview" ? t("opencodeV2PresetName") : preset.name,
          protocol: preset.protocol,
          transport: preset.transport,
          processCommand: preset.process?.command ?? "",
          processArgs: preset.process?.args?.join(" ") ?? "",
          networkEndpoint: preset.network?.endpoint ?? "",
          defaultPermissionMode: preset.defaultPermissionMode,
          description:
            initialPreset === "opencode-v2-preview"
              ? t("opencodeV2PresetDescription")
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
      // The preview adapter discovers the local service and ephemeral auth
      // through the desktop sidecar; no endpoint or process is persisted.
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
      if (!formData.processCommand.trim()) {
        toast.error(t("commandRequired"))
        return
      }
      input.process = {
        command: formData.processCommand.trim(),
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

    if (formData.protocol === "pi-rpc") {
      // The adapter reads this off `metadata` when building spawn args, so it
      // must survive an edit that started from a preset (which supplies its
      // own metadata bag above).
      input.metadata = {
        ...(input.metadata ?? {}),
        piExtensionPolicy: formData.piExtensionPolicy,
      }
    }

    onSave(input)
    onOpenChange(false)
    setFormData(DEFAULT_FORM_DATA)
    setSelectedPreset("")
  }, [formData, selectedPreset, onSave, onOpenChange, t])

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
        name: presetId === "opencode-v2-preview" ? t("opencodeV2PresetName") : preset.name,
        protocol: preset.protocol,
        transport: preset.transport,
        processCommand: preset.process?.command || current.processCommand,
        processArgs: preset.process?.args?.join(" ") || current.processArgs,
        networkEndpoint: preset.network?.endpoint || current.networkEndpoint,
        defaultPermissionMode: preset.defaultPermissionMode,
        description:
          presetId === "opencode-v2-preview"
            ? t("opencodeV2PresetDescription")
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
                            {presetId === "opencode-v2-preview"
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
                  disabled={formData.protocol === "codex-app-server"}
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
                  <div className="grid gap-2">
                    <Label htmlFor="command">{t("command")}</Label>
                    <Input
                      id="command"
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

// =============================================================================
// Preset Gallery Card
// =============================================================================

interface PresetGalleryCardProps {
  disabled: boolean
  onPick: (presetId: string) => void
}

const CODEX_EXECUTABLE_PRESET_IDS = ["codex", "codex-app-server"] as const

function PresetGalleryCard({ disabled, onPick }: PresetGalleryCardProps) {
  const t = useTranslations("externalAgent.settings")
  const [showExperimental, setShowExperimental] = useState(false)
  // Auto-prefer the native app-server Codex preset when the `codex` CLI is on
  // PATH; otherwise the ACP shim. Surfaced as a "Recommended" hint — both stay
  // selectable. Defaults to the ACP preset until detection resolves.
  const [preferredCodexPreset, setPreferredCodexPreset] = useState<string>("codex")
  useEffect(() => {
    let active = true
    void resolvePreferredCodexExecutablePresetId().then((id) => {
      if (active) setPreferredCodexPreset(id)
    })
    return () => {
      active = false
    }
  }, [])

  const presets = getAvailablePresets()
    .map((id) => ({ id, config: getPresetConfig(id) }))
    .filter(
      (entry): entry is { id: string; config: NonNullable<ReturnType<typeof getPresetConfig>> } =>
        entry.config !== null
    )
    .filter(({ config }) => showExperimental || config.supportTier !== "documented-only")

  return (
    <Card data-testid="preset-gallery-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{t("quickStartTitle")}</CardTitle>
            <CardDescription>{t("quickStartDescription")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="show-experimental-presets" className="text-xs">
              {t("showExperimental")}
            </Label>
            <Switch
              id="show-experimental-presets"
              checked={showExperimental}
              onCheckedChange={setShowExperimental}
              disabled={disabled}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {presets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("presetGalleryEmpty")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {presets.map(({ id, config }) => (
              <Card key={id} data-testid={`preset-card-${id}`} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <BrandIcon id={id} size={24} />
                    <p className="truncate text-sm font-medium">
                      {id === "opencode-v2-preview" ? t("opencodeV2PresetName") : config.name}
                    </p>
                  </div>
                  {(CODEX_EXECUTABLE_PRESET_IDS as readonly string[]).includes(id) &&
                    id === preferredCodexPreset && (
                      <Badge
                        variant="default"
                        className="text-[10px]"
                        data-testid={`preset-recommended-${id}`}
                      >
                        {t("recommendedPreset")}
                      </Badge>
                    )}
                  {config.supportTier && (
                    <Badge
                      variant={
                        config.supportTier === "documented-only"
                          ? "destructive"
                          : config.supportTier === "guided"
                            ? "secondary"
                            : "outline"
                      }
                      className="text-[10px]"
                    >
                      {config.supportTier}
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">
                  {id === "opencode-v2-preview"
                    ? t("opencodeV2PresetDescription")
                    : config.description}
                </p>
                {/* `tags` is optional on the preset type and a plugin can register
                    a preset at runtime, so the gallery must not assume the array
                    exists — reading through it blanked the whole section. */}
                {(config.tags?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {config.tags!.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPick(id)}
                    disabled={disabled || config.supportTier === "documented-only"}
                    data-testid={`preset-pick-${id}`}
                  >
                    {t("useThisPreset")}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Agent Detail Panel
// =============================================================================

interface AgentDetailProps {
  /** The stored config, lifecycle verdict included — `ExternalAgentConfig`
   *  alone drops the fields reconciliation writes. */
  agent: LifecycleExternalAgentConfig
  isConnecting: boolean
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
}

const ACP_PREVIEW_FEATURES: readonly AcpPreviewFeature[] = [
  "compaction",
  "providers",
  "dynamicMcp",
  "nes",
  "identifiedPlans",
  "previewToolNames",
  "sessionFork",
]

function AcpFeatureSettings({
  agent,
  applyUpdate,
}: {
  agent: LifecycleExternalAgentConfig
  applyUpdate: (updates: UpdateExternalAgentInput) => Promise<void>
}) {
  const t = useTranslations("externalAgent.settings")
  const preview =
    agent.metadata?.acpPreviewFeatures && typeof agent.metadata.acpPreviewFeatures === "object"
      ? (agent.metadata.acpPreviewFeatures as Partial<Record<AcpPreviewFeature, boolean>>)
      : {}
  const updateMetadata = (next: Record<string, unknown>) =>
    applyUpdate({ metadata: { ...(agent.metadata ?? {}), ...next } })

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="acp-feature-settings">
      <div>
        <p className="text-sm font-medium">{t("acpFeatureSettingsTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("acpFeatureSettingsDescription")}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`acp-elicitation-${agent.id}`} className="text-sm font-normal">
          {t("acpStableElicitation")}
        </Label>
        <Switch
          id={`acp-elicitation-${agent.id}`}
          checked={agent.metadata?.acpElicitationEnabled !== false}
          onCheckedChange={(checked) => {
            void updateMetadata({ acpElicitationEnabled: checked })
          }}
        />
      </div>
      <Separator />
      <p className="text-xs font-medium text-muted-foreground">{t("acpPreviewFeatures")}</p>
      {ACP_PREVIEW_FEATURES.map((feature) => (
        <div key={feature} className="flex items-center justify-between gap-3">
          <Label htmlFor={`acp-preview-${agent.id}-${feature}`} className="text-sm font-normal">
            {t(`acpPreview.${feature}`)}
          </Label>
          <Switch
            id={`acp-preview-${agent.id}-${feature}`}
            checked={preview[feature] === true}
            onCheckedChange={(checked) => {
              void updateMetadata({
                acpPreviewFeatures: { ...preview, [feature]: checked },
                ...(feature === "providers" ? { acpProviderController: checked } : {}),
                ...(feature === "nes" ? { acpNesController: checked } : {}),
              })
            }}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * Right-hand detail pane for the selected agent. Renders the full connection
 * config, ecosystem metadata, the native Codex app-server status (when
 * applicable), and the connect/edit/delete actions. Replaces the old per-row
 * `Collapsible` drawer so the wide settings frame is actually used.
 */
function AgentDetail({
  agent,
  isConnecting,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: AgentDetailProps) {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const { getConnectionStatus, getAgentValidity } = useExternalAgentStore()

  // Even a metadata-only write goes through the lifecycle service. The Pi
  // migration next to it rewrites `process`, which IS runtime-affecting, and
  // having one of the two paths bypass the service is how the store and the
  // live adapter drifted apart in the first place.
  const applyUpdate = useCallback(
    async (updates: UpdateExternalAgentInput) => {
      const lifecycle = await getExternalAgentLifecycleService()
      await lifecycle.updateConfig(agent.id, updates)
    },
    [agent.id]
  )

  const status = getConnectionStatus(agent.id)
  const isConnected = status === "connected"
  const runtimeValidity = getAgentValidity(agent.id)
  const executionBlockedReason =
    (runtimeValidity?.executable === false ? runtimeValidity.blockingReason : null) ??
    getExternalAgentExecutionBlockReason(agent)
  const ecosystem =
    runtimeValidity?.ecosystem ??
    agent.validitySnapshot?.ecosystem ??
    getExternalAgentEcosystemReadiness(agent)
  const supportTier = ecosystem?.supportTier
  const supportTierVariant =
    supportTier === "documented-only"
      ? "destructive"
      : supportTier === "guided"
        ? "secondary"
        : "outline"

  return (
    <Card data-testid={`agent-detail-${agent.id}`}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ConnectionStatusIcon status={status} />
              <CardTitle className="truncate">{agent.name}</CardTitle>
              <Badge variant="outline" className="text-xs">
                {agent.protocol.toUpperCase()}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {agent.transport}
              </Badge>
              {supportTier && (
                <Badge variant={supportTierVariant} className="text-xs">
                  {supportTier}
                </Badge>
              )}
              {/* A decision made weeks ago governs every later run; without a
                  standing indicator the one agent with no sandbox looks exactly
                  like the ones that have one. */}
              <UnsandboxedStatusBadge
                unsandboxed={Boolean(agent.unsandboxedConsent)}
                executablePath={agent.unsandboxedConsent?.executablePath}
              />
            </div>
            {agent.description && <CardDescription>{agent.description}</CardDescription>}
            {executionBlockedReason && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{executionBlockedReason}</p>
            )}
            {/* Reconciliation has always recorded WHY an agent cannot start and
                nothing read it back, so one that was switched off at startup
                looked simply disabled. */}
            <LifecycleStatusNotice
              status={agent.lifecycleStatus}
              reasonCode={agent.lifecycleReasonCode}
              action={
                agent.lifecycleStatus === "needs-consent" ? (
                  <UnsandboxedConsentAction agent={agent} />
                ) : null
              }
            />
          </div>
          {/* Every action for this agent lives in one row next to its title —
              previously Edit/Delete sat at the very bottom of the card, below
              the status panels, which meant scrolling past them to rename. */}
          <div className="flex shrink-0 items-center gap-2">
            {isConnected ? (
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                <PowerOff className="mr-1 h-4 w-4" />
                {t("disconnect")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={onConnect}
                disabled={isConnecting || !!executionBlockedReason}
              >
                {isConnecting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Power className="mr-1 h-4 w-4" />
                )}
                {t("connect")}
              </Button>
            )}
            <Button variant="outline" size="icon" aria-label={tCommon("edit")} onClick={onEdit}>
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={tCommon("delete")}
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {agent.protocol === "acp" && <AcpFeatureSettings agent={agent} applyUpdate={applyUpdate} />}
        {agent.metadata?.providerUndoWarningAcknowledged === true && (
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">{t("providerUndoWarningSetting")}</p>
              <p className="text-xs text-muted-foreground">
                {t("providerUndoWarningSettingDescription")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void applyUpdate({ metadata: { providerUndoWarningAcknowledged: false } })
              }}
              data-testid="reset-provider-undo-warning"
            >
              {t("providerUndoWarningReset")}
            </Button>
          </div>
        )}
        {/* Agent Details */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm @lg/agents-pane:grid-cols-2">
          <div>
            <span className="text-muted-foreground">{t("transport")}:</span>
            <span className="ml-2">{agent.transport}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t("detailTimeout")}:</span>
            <span className="ml-2">{agent.timeout ?? 300000}ms</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t("detailRetry")}:</span>
            <span className="ml-2">
              {agent.retryConfig?.maxRetries ?? 3} @ {agent.retryConfig?.retryDelay ?? 1000}ms
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">{t("detailBackoff")}:</span>
            <span className="ml-2">
              {(agent.retryConfig?.exponentialBackoff ?? true)
                ? t("backoffExponential")
                : t("backoffFixed")}
            </span>
          </div>
          {agent.process && (
            <>
              <div>
                <span className="text-muted-foreground">{t("command")}:</span>
                <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.process.command}</code>
              </div>
              {agent.process.cwd && (
                <div className="@lg/agents-pane:col-span-2">
                  <span className="text-muted-foreground">{t("workingDirectory")}:</span>
                  <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.process.cwd}</code>
                </div>
              )}
            </>
          )}
          {agent.network && (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("endpoint")}:</span>
              <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.network.endpoint}</code>
            </div>
          )}
          {ecosystem?.adapterName && (
            <div>
              <span className="text-muted-foreground">{t("detailsAdapter")}:</span>
              <span className="ml-2">{ecosystem.adapterName}</span>
            </div>
          )}
          {ecosystem?.surfaceName && (
            <div>
              <span className="text-muted-foreground">{t("detailsSurface")}:</span>
              <span className="ml-2">{ecosystem.surfaceName}</span>
            </div>
          )}
          {/* Support tier is already a badge in the header — not repeated here. */}
          {ecosystem?.prerequisiteStatus && (
            <div>
              <span className="text-muted-foreground">{t("detailsPrerequisiteStatus")}:</span>
              <span className="ml-2">{ecosystem.prerequisiteStatus}</span>
            </div>
          )}
          {ecosystem?.docsUrl && (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("detailsOfficialDocs")}:</span>
              <a
                href={ecosystem.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("detailsDocsLink")}
              </a>
            </div>
          )}
          {ecosystem?.limitationNote && (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("detailsLimitation")}:</span>
              <span className="ml-2">{ecosystem.limitationNote}</span>
            </div>
          )}
          {ecosystem?.recommendedActions?.length ? (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("detailsRecommendedActions")}:</span>
              <span className="ml-2">{ecosystem.recommendedActions.join(" | ")}</span>
            </div>
          ) : null}
        </div>

        {/* Native Codex app-server status (MCP servers + skills) */}
        {agent.protocol === "codex-app-server" && (
          <CodexAppServerStatusCard agentId={agent.id} connected={isConnected} />
        )}

        {/* OpenCode server status (project / providers / agents / MCP / LSP) */}
        {agent.protocol === "opencode" && (
          <OpencodeStatusCard agentId={agent.id} connected={isConnected} />
        )}

        {/* Pi native RPC: which providers Pi can actually authenticate (ADR-0119). */}
        {agent.protocol === "pi-rpc" && (
          <PiAuthStatusCard agentId={agent.id} connected={isConnected} />
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Main Settings Component
// =============================================================================

/** What the right-hand detail pane is currently showing. */
type DetailView =
  | { kind: "gallery" }
  | { kind: "global" }
  | { kind: "delegation" }
  | { kind: "runtimes" }
  | { kind: "host" }
  | { kind: "agent"; id: string }

/** A single entry in the left navigation rail. */
function RailItem({
  icon: Icon,
  label,
  active,
  onClick,
  dataTestId,
}: {
  icon: typeof Settings2
  label: string
  active: boolean
  onClick: () => void
  dataTestId: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-pressed={active}
      data-testid={dataTestId}
      className={cn(
        "h-auto w-full justify-start gap-2 whitespace-normal rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-accent/50",
        active && "bg-accent font-medium text-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </Button>
  )
}

export function ExternalAgentSettings() {
  const t = useTranslations("externalAgent.settings")
  const tRuntimes = useTranslations("externalAgent.runtimes")
  const tHostConfigs = useTranslations("externalAgent.hostConfigs")
  const tCommon = useTranslations("common")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")

  // Store
  const {
    getAllAgents,
    getAgent,
    getConnectionStatus,
    getAgentValidity,
    enabled,
    setEnabled,
    defaultPermissionMode,
    setDefaultPermissionMode,
    autoConnectOnStartup,
    setAutoConnectOnStartup,
    showConnectionNotifications,
    setShowConnectionNotifications,
    chatFailurePolicy,
    setChatFailurePolicy,
  } = useExternalAgentStore()

  // Hook for connection management
  const { connect, disconnect } = useExternalAgent()

  // Platform gate. Resolved once: `isMacPlatform`-style helpers read the Tauri
  // OS plugin, which is synchronous but only meaningful on desktop — a browser
  // shell has no spawn path to sandbox and must not show the warning.
  const sandboxAvailable = useMemo(() => {
    if (!isTauri()) return true
    try {
      return externalAgentSandboxSupportsPlatform(tauriPlatform())
    } catch {
      // The OS plugin is unavailable (older shell / test env). Refusing here
      // would put a scary banner in front of users we know nothing about.
      return true
    }
  }, [])

  // Check if a specific agent is connecting
  const isConnecting = useCallback(
    (agentId: string) => {
      const status = getConnectionStatus(agentId)
      return status === "connecting" || status === "reconnecting"
    },
    [getConnectionStatus]
  )

  // Local state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  // Master/detail selection. The rail can point at an agent or at one of the
  // three non-agent panels; the quick-start gallery is the landing view.
  const [view, setView] = useState<DetailView>({ kind: "gallery" })
  const selectedAgentId = view.kind === "agent" ? view.id : null
  // Preset id seeded into the AgentEditorDialog when opening from the
  // quick-start gallery. Empty when the user opens the manual "Add agent"
  // button.
  const [selectedPresetForNew, setSelectedPresetForNew] = useState<string>("")

  // Get agents
  const agents = getAllAgents()

  // Handlers
  //
  // Every mutation goes through the lifecycle service rather than the store.
  // Writing to the store directly persisted the change and left the runtime
  // manager holding the old state: an agent added here was not registered
  // until the next app restart, an edit left the previous configuration
  // connected, and a delete could leave the child process running.
  const handleAddAgent = useCallback(
    async (data: CreateExternalAgentInput) => {
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        await lifecycle.createConfig(data)
        toast.success(t("agentAdded"))
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
      }
    },
    [t, tErrors]
  )

  const handleEditAgent = useCallback((agentId: string) => {
    setEditingAgentId(agentId)
    setEditorOpen(true)
  }, [])

  const handleUpdateAgent = useCallback(
    async (data: CreateExternalAgentInput) => {
      const agentId = editingAgentId
      setEditingAgentId(null)
      if (!agentId) return
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        await lifecycle.updateConfig(agentId, data)
        toast.success(t("agentUpdated"))
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
      }
    },
    [editingAgentId, t, tErrors]
  )

  const handleDeleteAgent = useCallback(async () => {
    const agentId = deleteConfirmId
    setDeleteConfirmId(null)
    if (!agentId) return
    try {
      const lifecycle = await getExternalAgentLifecycleService()
      await lifecycle.removeConfig(agentId)
      toast.success(t("agentRemoved"))
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    }
  }, [deleteConfirmId, t, tErrors])

  const handleConnect = useCallback(
    async (agentId: string) => {
      try {
        const agent = getAgent(agentId)
        if (!agent) {
          throw new Error("Agent not found")
        }
        const runtimeValidity = getAgentValidity(agentId)
        const blockedReason =
          (runtimeValidity?.executable === false ? runtimeValidity.blockingReason : null) ??
          getExternalAgentExecutionBlockReason(agent)
        if (blockedReason) {
          throw new Error(blockedReason)
        }
        await connect(agentId)
        toast.success(t("connected"))
      } catch (error) {
        toast.error(t("connectionFailed"), {
          description: (error as Error).message,
        })
      }
    },
    [connect, t, getAgent, getAgentValidity]
  )

  const handleDisconnect = useCallback(
    async (agentId: string) => {
      try {
        await disconnect(agentId)
        toast.success(t("disconnected"))
      } catch (_error) {
        toast.error(t("disconnectFailed"))
      }
    },
    [disconnect, t]
  )

  // Keep the selection valid: if the selected agent is removed, fall back to
  // the gallery (null) so the detail pane never points at a missing agent.
  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId)
    : undefined

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Page header — title, the master enable switch, and the add action stay
          pinned above the scrolling body so they are always reachable. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex min-w-0 items-center gap-2">
          <ExternalLink className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{t("title")}</h2>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="enable-external-agents" className="text-sm">
              {t("enableExternalAgents")}
            </Label>
            <Switch id="enable-external-agents" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <Button
            onClick={() => {
              setSelectedPresetForNew("")
              setEditingAgentId(null)
              setEditorOpen(true)
            }}
            disabled={!enabled}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("addAgent")}
          </Button>
        </div>
      </div>

      {/* Cognia never runs an external agent unsandboxed, and only macOS
          Seatbelt and Linux bubblewrap qualify. Until now the only place that
          knew was a throw inside the launcher, so a Windows user could
          configure an agent, save it, connect it, and discover at spawn time
          that it could never have run. */}
      {!sandboxAvailable && (
        <div
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
          data-testid="external-agent-sandbox-unavailable"
        >
          {t("sandboxUnavailableOnPlatform")}
        </div>
      )}

      {/* Two-pane body. The outer div only declares the container (an element
          cannot query the container it declares); the inner div does the
          responsive split. Global settings, delegation rules and the preset
          gallery used to stack above the agent list in one long page scroll —
          they are rail entries now, which also restores the (previously
          missing) way back to the gallery once an agent has been selected. */}
      <div className="min-h-0 flex-1 pt-3 @container/agents-pane">
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-0.5 @3xl/agents-pane:flex-row @3xl/agents-pane:overflow-hidden">
          {/* Navigation rail */}
          <aside className="shrink-0 space-y-4 @3xl/agents-pane:w-60 @3xl/agents-pane:overflow-y-auto @3xl/agents-pane:pr-1">
            <nav className="space-y-1">
              <p className="px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("navGeneral")}
              </p>
              <RailItem
                icon={Settings2}
                label={t("globalSettings")}
                active={view.kind === "global"}
                onClick={() => setView({ kind: "global" })}
                dataTestId="nav-global-settings"
              />
              <RailItem
                icon={Route}
                label={t("delegation.title")}
                active={view.kind === "delegation"}
                onClick={() => setView({ kind: "delegation" })}
                dataTestId="nav-delegation"
              />
              <RailItem
                icon={Sparkles}
                label={t("quickStartTitle")}
                active={view.kind === "gallery"}
                onClick={() => setView({ kind: "gallery" })}
                dataTestId="nav-quick-start"
              />
              <RailItem
                icon={Boxes}
                label={tRuntimes("title")}
                active={view.kind === "runtimes"}
                onClick={() => setView({ kind: "runtimes" })}
                dataTestId="nav-runtimes"
              />
              {/* Agents the paired host owns. A rail entry rather than a
                  section stacked under the local list, because the two answer
                  different questions — "what have I configured here" versus
                  "what can actually run over there" — and interleaving them
                  made a browser's unrunnable local agents look equivalent to
                  the host's runnable ones. */}
              <RailItem
                icon={ServerCog}
                label={tHostConfigs("title")}
                active={view.kind === "host"}
                onClick={() => setView({ kind: "host" })}
                dataTestId="nav-host-configs"
              />
            </nav>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 px-2">
                <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t("configuredAgents")}
                </p>
                {agents.length > 0 && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {agents.length}
                  </Badge>
                )}
              </div>
              {agents.length === 0 ? (
                <Empty className="border-0 py-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ExternalLink className="h-6 w-6" />
                    </EmptyMedia>
                    <EmptyTitle>{t("noAgentsConfigured")}</EmptyTitle>
                    <EmptyDescription>{t("addAgentToStart")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="space-y-1">
                  {agents.map((agent) => {
                    const status = getConnectionStatus(agent.id)
                    const runtimeValidity = getAgentValidity(agent.id)
                    const executionBlockedReason =
                      (runtimeValidity?.executable === false
                        ? runtimeValidity.blockingReason
                        : null) ?? getExternalAgentExecutionBlockReason(agent)
                    const fromPresetId = isFromPreset(agent)
                    const fromPresetName = fromPresetId
                      ? getPresetDisplayInfo(fromPresetId)?.name
                      : null
                    const isSelected = selectedAgentId === agent.id
                    const connected = status === "connected"

                    return (
                      // Row + quick power action are siblings: a nested button
                      // inside the row button would be invalid HTML.
                      <div
                        key={agent.id}
                        className={cn(
                          "flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent/50",
                          isSelected && "bg-accent"
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          data-testid={`agent-row-${agent.id}`}
                          onClick={() => setView({ kind: "agent", id: agent.id })}
                          aria-pressed={isSelected}
                          className="h-auto min-w-0 flex-1 justify-start whitespace-normal rounded-md px-2 py-1.5 text-left font-normal"
                        >
                          <div className="flex items-center gap-2">
                            <ConnectionStatusIcon status={status} />
                            <BrandIcon
                              id={fromPresetId ?? agent.name}
                              label={agent.name}
                              size={20}
                            />
                            <span
                              className={cn(
                                "truncate text-sm",
                                isSelected && "font-medium text-accent-foreground"
                              )}
                            >
                              {agent.name}
                            </span>
                            {fromPresetName && (
                              <Badge
                                variant="outline"
                                className="shrink-0 text-[10px]"
                                data-testid={`agent-from-preset-${agent.id}`}
                              >
                                {fromPresetName}
                              </Badge>
                            )}
                          </div>
                          <p className="truncate pl-6 text-[11px] text-muted-foreground">
                            {executionBlockedReason ? (
                              <span className="text-amber-600 dark:text-amber-400">
                                {executionBlockedReason}
                              </span>
                            ) : (
                              `${agent.protocol} · ${agent.transport}`
                            )}
                          </p>
                        </Button>
                        {/* Connect without leaving the list — the most frequent
                            action was previously two clicks deep. */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          aria-label={
                            connected
                              ? t("quickDisconnect", { name: agent.name })
                              : t("quickConnect", { name: agent.name })
                          }
                          data-testid={`agent-power-${agent.id}`}
                          disabled={
                            !enabled ||
                            isConnecting(agent.id) ||
                            (!connected && !!executionBlockedReason)
                          }
                          onClick={() =>
                            connected ? handleDisconnect(agent.id) : handleConnect(agent.id)
                          }
                        >
                          {isConnecting(agent.id) ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : connected ? (
                            <PowerOff className="h-3.5 w-3.5" />
                          ) : (
                            <Power className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>

          {/* Detail pane */}
          <section className="min-w-0 flex-1 @3xl/agents-pane:overflow-y-auto @3xl/agents-pane:pr-1">
            {view.kind === "delegation" && <DelegationRulesSection disabled={!enabled} />}

            {/* The catalog, the version probe and the certification policy all
                existed with no caller: a verdict was computed for nobody. This
                is where they surface. */}
            {view.kind === "runtimes" && <RuntimeGovernancePanel />}

            {view.kind === "host" && <HostExternalAgentConfigs />}

            {view.kind === "gallery" && (
              <div className="space-y-4">
                <PresetGalleryCard
                  disabled={!enabled}
                  onPick={(presetId) => {
                    setSelectedPresetForNew(presetId)
                    setEditingAgentId(null)
                    setEditorOpen(true)
                  }}
                />
                {/* DeepSeek Harness is the one backend with no binary to detect,
                    so its install lives here rather than behind a preset pick. */}
                <DeepSeekHarnessCard />
              </div>
            )}

            {view.kind === "agent" &&
              (selectedAgent ? (
                <AgentDetail
                  agent={selectedAgent}
                  isConnecting={isConnecting(selectedAgent.id)}
                  onConnect={() => handleConnect(selectedAgent.id)}
                  onDisconnect={() => handleDisconnect(selectedAgent.id)}
                  onEdit={() => handleEditAgent(selectedAgent.id)}
                  onDelete={() => setDeleteConfirmId(selectedAgent.id)}
                />
              ) : null)}

            {view.kind === "global" && (
              <Card data-testid="global-settings-card">
                <CardHeader>
                  <CardTitle>{t("globalSettings")}</CardTitle>
                  <CardDescription>{t("globalSettingsDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Auto Connect */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>{t("autoConnect")}</Label>
                      <p className="text-sm text-muted-foreground">{t("autoConnectDesc")}</p>
                    </div>
                    <Switch
                      checked={autoConnectOnStartup}
                      onCheckedChange={setAutoConnectOnStartup}
                      disabled={!enabled}
                    />
                  </div>

                  {/* Notifications */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>{t("showNotifications")}</Label>
                      <p className="text-sm text-muted-foreground">{t("showNotificationsDesc")}</p>
                    </div>
                    <Switch
                      checked={showConnectionNotifications}
                      onCheckedChange={setShowConnectionNotifications}
                      disabled={!enabled}
                    />
                  </div>

                  <Separator />

                  {/* Default Permission Mode */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>{t("defaultPermissionMode")}</Label>
                      <p className="text-sm text-muted-foreground">
                        {t("defaultPermissionModeDesc")}
                      </p>
                    </div>
                    <Select
                      value={defaultPermissionMode}
                      onValueChange={(v) =>
                        setDefaultPermissionMode(
                          v as "default" | "acceptEdits" | "bypassPermissions" | "plan"
                        )
                      }
                      disabled={!enabled}
                    >
                      <SelectTrigger className="w-full sm:w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">{t("permissionDefault")}</SelectItem>
                        <SelectItem value="acceptEdits">{t("permissionAcceptEdits")}</SelectItem>
                        <SelectItem value="bypassPermissions">{t("permissionBypass")}</SelectItem>
                        <SelectItem value="plan">{t("permissionPlan")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  {/* External Failure Policy */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>{t("chatFailurePolicy")}</Label>
                      <p className="text-sm text-muted-foreground">{t("chatFailurePolicyDesc")}</p>
                    </div>
                    <Select
                      value={chatFailurePolicy}
                      onValueChange={(value) =>
                        setChatFailurePolicy(value as "fallback" | "strict")
                      }
                      disabled={!enabled}
                    >
                      <SelectTrigger className="w-full sm:w-[220px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fallback">{t("chatFailurePolicyFallback")}</SelectItem>
                        <SelectItem value="strict">{t("chatFailurePolicyStrict")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      </div>

      {/* Agent Editor Dialog */}
      <AgentEditorDialog
        key={`agent-editor-${editingAgentId ?? "new"}-${selectedPresetForNew || "manual"}-${editorOpen ? "open" : "closed"}`}
        open={editorOpen}
        onOpenChange={(next) => {
          setEditorOpen(next)
          if (!next) setSelectedPresetForNew("")
        }}
        editingAgentId={editingAgentId}
        initialPreset={editingAgentId ? "" : selectedPresetForNew}
        onSave={editingAgentId ? handleUpdateAgent : handleAddAgent}
      />

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteAgent")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteAgentConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAgent}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ExternalAgentSettings
