"use client"

/**
 * AgentEditorDialog — the full create/edit form for an external agent.
 *
 * Extracted from `external-agent-settings.tsx` when the page moved to the
 * rail + overview + inspector layout: the inspector covers quick inline
 * edits, and this dialog stays the deep editor — preset seeding, protocol
 * selection, and every protocol-specific option (Codex sandbox, OpenCode
 * server auth, Pi extension policy, managed DeepSeek Harness), plus the
 * per-configuration choices that let several configurations of one runtime
 * coexist (ADR-0216): state isolation, subscription account, session limits
 * and approval rules.
 *
 * Rendered through `ResponsiveFormDialog`: a Dialog on desktop, a bottom
 * Drawer on a phone. All form state lives in this component, above the shell,
 * so a resize across the breakpoint (which swaps the shell) loses nothing.
 */

import { Surface } from "@/components/surface/surface"
import { KvEditor } from "@/components/settings/mcp/kv-editor"
import { kvRowsToObject, objectToKvRows } from "@/components/settings/mcp/mcp-server-utils"
import { ChipInput } from "@/components/settings/gateway/shared/chip-input"
import { useState, useCallback, useId } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ChevronDown, FolderPlus, Globe, PackageIcon, Terminal } from "lucide-react"

import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"
import { CogniaModelPicker } from "@/components/agent/external-agent/cognia-model-picker"
import {
  StateIsolationField,
  defaultStateIsolationFor,
  stateIsolationSupported,
} from "@/components/agent/external-agent/add-agent/state-isolation-field"
import {
  presetDescription,
  presetEnvironmentLabel,
  presetName,
  presetSetupHint,
} from "@/components/agent/external-agent/add-agent/preset-copy"
import { shellQuote, tokenizeShellCommand } from "@/lib/mcp/config-transfer"
import { useRemoteHostActive } from "@/hooks/use-host-profile"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { isTauri } from "@/lib/platform/detect"
import { piPackagesHref } from "@/lib/pi-packages/deep-link"
import { externalProtocolOptions } from "@/lib/ai/agent/external/protocol-options"
import { canUseCogniaModels } from "@/lib/ai/agent/external/config/gateway-task"
import { getPresetConfig, getRunnablePresets } from "@/lib/ai/agent/external/config/presets"
import { CODEX_PRESET_FAMILY } from "@/lib/ai/agent/external/config/agent-binding"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/policy/permission-modes"
import {
  extensionPolicyArgs,
  piPackageRefsFromMetadata,
  resolvePiExtensionPolicy,
  type PiExtensionPolicy,
} from "@cognia/agent-pi/rpc-client"
import { PiPluginPackagesField } from "./pi-plugin-packages-field"
import {
  useExternalAgentStore,
  type LifecycleExternalAgentConfig,
} from "@/stores/agent/external-agent-store"
import type {
  AcpPermissionMode,
  CreateExternalAgentInput,
  ExternalAgentProtocol,
  ExternalAgentStateIsolation,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"
import type { ExternalAgentCredentialSlot } from "@/types/agent/external-agent-lifecycle"

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

/**
 * What the editor hands its parent on save.
 *
 * A create input, except that the two session-limit fields may be `null`: on
 * an EDIT, `null` clears a limit the configuration had saved (back to "no
 * limit" / "use the execution timeout"), which an omitted key cannot express
 * because an update leaves omitted keys alone. A create never carries `null`.
 */
export type AgentEditorSaveInput = Omit<
  CreateExternalAgentInput,
  "maxConcurrentSessions" | "sessionIdleTimeout"
> & {
  maxConcurrentSessions?: number | null
  sessionIdleTimeout?: number | null
}

interface AgentFormData {
  cogniaModel?: CreateExternalAgentInput["cogniaModel"]
  name: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  // Process config (for stdio)
  processCommand: string
  processArgs: string
  processCwd: string
  processEnv?: Record<string, string>
  // Network config (for http/websocket)
  networkEndpoint: string
  /**
   * A NEW API key. A saved one is a keyring credential the editor cannot read
   * back; empty means "keep whatever is saved".
   */
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
  // Instances (ADR-0216)
  /** The choice as made; `effectiveStateIsolation` clamps it to what the runtime allows. */
  stateIsolation: ExternalAgentStateIsolation
  /** `null` follows the globally active account. Codex family only. */
  subscriptionAccountId: string | null
  /** Empty string = no limit. */
  maxConcurrentSessions: string
  /** Empty string = fall back to the execution timeout. */
  sessionIdleTimeoutMs: string
  requireApprovalFor: string[]
  autoApprovePatterns: string[]
  /**
   * Secrets the user asked to remove. They live in the keyring, not in the
   * config, so an empty input cannot clear them: the removal runs through the
   * lifecycle service after the save succeeds.
   */
  clearServerPassword: boolean
  clearApiKey: boolean
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
  /**
   * A NEW server password. The saved one is a keyring credential the editor
   * cannot read back; empty means "keep whatever is saved".
   */
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
  /**
   * Plugin-shipped Pi packages this agent loads in every hosted session
   * (`metadata.piPackages`, `<pluginId>/<packageId>` references, ADR-0210).
   */
  piPackages: string[]
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

/**
 * Is `value` a well-formed approval entry? The `allowedTools` syntax the
 * runtime matches with (`configuredApprovalPolicy`): a tool name, or
 * `Tool(specifier)` with the closing parenthesis. An entry without one is
 * accepted by the matcher but silently reads to the end of the string, which
 * is never what was meant.
 */
export function isApprovalEntryValid(value: string): boolean {
  const open = value.indexOf("(")
  const base = (open >= 0 ? value.slice(0, open) : value).trim()
  if (!base || base.includes(")")) return false
  return open < 0 || value.trimEnd().endsWith(")")
}

/**
 * Parse an optional positive-integer field. `""` → `undefined` (unset);
 * anything that is not a whole number above zero → `null` (invalid).
 */
function parseOptionalPositiveInteger(value: string): number | undefined | null {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return parsed > 0 ? parsed : null
}

const DEFAULT_TIMEOUT_MS = "300000"
const DEFAULT_RETRY_MAX_RETRIES = "3"
const DEFAULT_RETRY_DELAY_MS = "1000"
const DEFAULT_RETRY_MAX_DELAY_MS = "30000"

/** Select value standing for "follow the active account" (`null`). */
const FOLLOW_ACTIVE_ACCOUNT = "__follow-active__"

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
  // A new configuration gets its own state where the runtime allows it; the
  // editor clamps this to "shared" for a runtime that cannot be isolated.
  stateIsolation: "isolated",
  subscriptionAccountId: null,
  maxConcurrentSessions: "",
  sessionIdleTimeoutMs: "",
  requireApprovalFor: [],
  autoApprovePatterns: [],
  clearServerPassword: false,
  clearApiKey: false,
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
  piPackages: [],
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

/**
 * Pull the OpenCode form fields out of an agent/preset `metadata` bag.
 *
 * The server password is not among them: it is a keyring credential, scrubbed
 * from the stored metadata, so there is nothing to read back.
 */
function opencodeFieldsFromMetadata(
  metadata: Record<string, unknown> | undefined
): Pick<
  AgentFormData,
  | "opencodeAutoSpawn"
  | "opencodePort"
  | "opencodeHostname"
  | "opencodeServerUsername"
  | "opencodeModel"
> {
  return {
    opencodeAutoSpawn: metadata?.autoSpawnServer === true,
    opencodePort: typeof metadata?.port === "number" ? String(metadata.port) : "",
    opencodeHostname: typeof metadata?.hostname === "string" ? metadata.hostname : "",
    opencodeServerUsername:
      typeof metadata?.serverUsername === "string" ? metadata.serverUsername : "",
    opencodeModel: typeof metadata?.model === "string" ? metadata.model : "",
  }
}

/** Static effort choices offered as per-agent defaults; the true per-model
 * list is session-level (from `model/list` supportedReasoningEfforts). */
const CODEX_EFFORT_CHOICES = ["minimal", "low", "medium", "high", "xhigh"] as const

/** Does this configuration run the Codex runtime (and so sign in with a Codex account)? */
function isCodexFamily(presetId: string, protocol: ExternalAgentProtocol): boolean {
  return CODEX_PRESET_FAMILY.includes(presetId) || protocol === "codex-app-server"
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// =============================================================================
// Field helpers
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
      <CollapsibleTrigger className="group flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left">
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

/**
 * The state of a secret the editor cannot read back (it lives in the keyring),
 * with the one action an empty input cannot express: removing it. Only shown
 * when editing a saved configuration.
 */
function SavedSecretState({
  saved,
  pendingRemoval,
  onPendingRemovalChange,
  testid,
}: {
  saved: boolean
  pendingRemoval: boolean
  onPendingRemovalChange: (next: boolean) => void
  testid: string
}) {
  const t = useTranslations("externalAgentManage.editor")
  if (!saved) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testid}-not-saved`}>
        {t("secretNotSaved")}
      </p>
    )
  }
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
      data-testid={`${testid}-saved`}
    >
      <span className="min-w-0">{pendingRemoval ? t("secretWillRemove") : t("secretSaved")}</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="touch-hit h-auto px-0 text-xs"
        onClick={() => onPendingRemovalChange(!pendingRemoval)}
      >
        {pendingRemoval ? t("secretKeep") : t("secretRemove")}
      </Button>
    </div>
  )
}

/**
 * Which Codex account this configuration signs in with. Accounts are read
 * from the subscription vault, which only the desktop app can open; anywhere
 * else the field explains that the configuration follows the active account
 * and offers nothing to change.
 */
function SubscriptionAccountField({
  id,
  value,
  onChange,
}: {
  id: string
  value: string | null
  onChange: (next: string | null) => void
}) {
  const t = useTranslations("externalAgentManage.editor")
  return (
    <div className="grid gap-2" data-testid="subscription-account-field">
      {isTauri() ? (
        <>
          <Label htmlFor={id}>{t("account")}</Label>
          <SubscriptionAccountSelect id={id} value={value} onChange={onChange} />
        </>
      ) : (
        <>
          {/* No control to label: the explanation stands in for it. */}
          <span className="text-sm font-medium">{t("account")}</span>
          <p
            className="text-xs text-muted-foreground"
            data-testid="subscription-account-unavailable"
          >
            {t("accountUnavailableWeb")}
          </p>
        </>
      )}
    </div>
  )
}

function SubscriptionAccountSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: string | null
  onChange: (next: string | null) => void
}) {
  const t = useTranslations("externalAgentManage.editor")
  const { accounts, loading, error } = useAccounts("codex")
  if (error) {
    return (
      <p
        className="text-xs text-amber-700 dark:text-amber-400"
        data-testid="subscription-account-error"
      >
        {t("accountLoadFailed", { error })}
      </p>
    )
  }
  const bound = value ? accounts.find((account) => account.id === value) : undefined
  return (
    <>
      <Select
        value={value ?? FOLLOW_ACTIVE_ACCOUNT}
        onValueChange={(next) => onChange(next === FOLLOW_ACTIVE_ACCOUNT ? null : next)}
        disabled={loading}
      >
        <SelectTrigger id={id} data-testid="subscription-account-select">
          <SelectValue placeholder={loading ? t("accountLoading") : undefined} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_ACTIVE_ACCOUNT}>{t("accountFollowActive")}</SelectItem>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.label || account.email || account.id}
            </SelectItem>
          ))}
          {/* A binding to an account that has since been removed stays
              visible as what it is, rather than the Select going blank. */}
          {value && !bound && !loading ? (
            <SelectItem value={value}>{t("accountMissing", { id: value })}</SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {loading
          ? t("accountLoading")
          : accounts.length === 0
            ? t("accountNone")
            : t("accountHint")}
      </p>
    </>
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
  /**
   * Persist the configuration. AWAITED: the dialog shows a saving state and
   * keeps every control disabled until it settles.
   *
   * Resolve `true` once it is saved: the dialog then runs any secret removal
   * the user asked for (`clearCredentialSlot`, edit only) and closes itself —
   * the parent does not need to close it. Resolve `false` when it was not
   * saved, after telling the user why (a toast): the dialog stays open with
   * the user's input intact so they can fix it and try again. A rejection is
   * treated like `false`, with a generic "could not save" toast.
   *
   * On create the input never carries `null`; on edit a `null` session limit
   * clears a saved one (see {@link AgentEditorSaveInput}).
   */
  onSave: (data: AgentEditorSaveInput) => Promise<boolean>
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
  const tManage = useTranslations("externalAgentManage.editor")
  const tCommon = useTranslations("common")
  const tGateway = useTranslations("externalAgent.cogniaModel")
  const { getAgent } = useExternalAgentStore()
  const editingAgent = editingAgentId ? getAgent(editingAgentId) : undefined

  // Control ids are scoped to this dialog instance. Global ids ("name",
  // "command") collided with every other form on the page that used the same
  // word, and a `<Label htmlFor>` then pointed at the wrong input.
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`

  // Quick-start preset selector — mirrors the chat-side AddAgentDialog pattern
  // in `components/agent/external-agent/manager.tsx`. Picking a preset fills
  // the form fields and stamps `metadata.preset` on save so `isFromPreset()`
  // can later badge the row.
  const [selectedPreset, setSelectedPreset] = useState<string>(
    initialPreset || (editingAgent ? String(editingAgent.metadata?.preset ?? "") : "")
  )
  // A native picker only resolves paths on this device, never on a remote Host.
  // Subscribed rather than read once: a desktop can attach to (or detach from)
  // a remote Host while this dialog is open, and a one-shot read kept offering
  // (or hiding) the picker for whichever machine was active at the last
  // unrelated re-render.
  const directoryPicker = useDirectoryPicker()
  const localPaths = !useRemoteHostActive()

  const [formData, setFormData] = useState<AgentFormData>(() => {
    // Quick-start gallery: open with the preset's defaults so the user only
    // has to tweak env vars / cwd before saving.
    if (!editingAgentId && initialPreset && initialPreset !== "custom") {
      const preset = getPresetConfig(initialPreset)
      if (preset) {
        return {
          ...DEFAULT_FORM_DATA,
          name: presetName(t, initialPreset, preset),
          protocol: preset.protocol,
          transport: preset.transport,
          processCommand: preset.process?.command ?? "",
          processArgs: preset.process?.args?.map(shellQuote).join(" ") ?? "",
          processEnv: preset.process?.env,
          networkEndpoint: preset.network?.endpoint ?? "",
          defaultPermissionMode: preset.defaultPermissionMode,
          description: presetDescription(t, initialPreset, preset),
          stateIsolation: defaultStateIsolationFor(preset.process?.command, preset.process?.args),
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
      ...DEFAULT_FORM_DATA,
      name: agent.name,
      cogniaModel: agent.cogniaModel,
      protocol: agent.protocol,
      transport: agent.transport,
      processCommand: agent.process?.command || "",
      processArgs: agent.process?.args?.map(shellQuote).join(" ") || "",
      processCwd: agent.process?.cwd || "",
      processEnv: agent.process?.env,
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
      // Absent is `shared`: every configuration saved before ADR-0216.
      stateIsolation: agent.stateIsolation ?? "shared",
      subscriptionAccountId: agent.subscriptionAccountId ?? null,
      maxConcurrentSessions: agent.maxConcurrentSessions ? String(agent.maxConcurrentSessions) : "",
      sessionIdleTimeoutMs: agent.sessionIdleTimeout ? String(agent.sessionIdleTimeout) : "",
      requireApprovalFor: agent.requireApprovalFor ?? [],
      autoApprovePatterns: agent.autoApprovePatterns ?? [],
      codexSandboxMode: agent.codexOptions?.sandboxMode ?? "workspaceWrite",
      codexNetworkAccess: agent.codexOptions?.networkAccess ?? false,
      codexDefaultEffort: agent.codexOptions?.defaultReasoningEffort ?? "",
      codexReasoningSummary: agent.codexOptions?.reasoningSummary ?? "",
      codexExtraSkillRoots: agent.codexOptions?.extraSkillRoots?.join("\n") ?? "",
      ...opencodeFieldsFromMetadata(agent.metadata),
      piExtensionPolicy: piExtensionPolicyFromMetadata(agent.metadata),
      piPackages: piPackageRefsFromMetadata(agent.metadata),
    }
  })

  const managedDsh = getPresetConfig(selectedPreset)?.metadata?.requiresManagedRuntime === true
  const [processEnvRows, setProcessEnvRows] = useState(() => objectToKvRows(formData.processEnv))
  const [submitting, setSubmitting] = useState(false)

  // The launch target the state-isolation rule is decided on. A managed or
  // network agent has no local command, and the field says so.
  const launchesProcess =
    formData.transport === "stdio" ||
    (formData.protocol === "opencode" && formData.opencodeAutoSpawn)
  const isolationCommand =
    managedDsh || !launchesProcess
      ? undefined
      : formData.processCommand.trim() || (formData.protocol === "opencode" ? "opencode" : "")
  const isolationArgs = tokenizeShellCommand(formData.processArgs) ?? []
  // A runtime with no home variable cannot be given its own state: whatever was
  // chosen, it runs on the shared one, and the saved value must say so.
  const effectiveStateIsolation: ExternalAgentStateIsolation =
    isolationCommand && !stateIsolationSupported(isolationCommand, isolationArgs)
      ? "shared"
      : formData.stateIsolation
  const movingToOwnState = Boolean(editingAgent) && editingAgent?.stateIsolation !== "isolated"

  const serverPasswordSaved = Boolean(editingAgent?.credentialRefs?.serverPassword)
  const apiKeySaved = Boolean(editingAgent?.credentialRefs?.apiKey)

  const presetConfig =
    selectedPreset && selectedPreset !== "custom" ? getPresetConfig(selectedPreset) : undefined
  const setupHint = presetConfig
    ? presetSetupHint(tManager, selectedPreset, presetConfig, t)
    : undefined
  const environmentLabel = presetEnvironmentLabel(t, selectedPreset, formData.protocol)
  const codexFamily = isCodexFamily(selectedPreset, formData.protocol)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // A save in flight owns the dialog: closing it would drop the input the
      // save may hand back on failure.
      if (!next && submitting) return
      onOpenChange(next)
    },
    [submitting, onOpenChange]
  )

  const handleSave = useCallback(async () => {
    const usesProcess =
      formData.transport === "stdio" ||
      (formData.protocol === "opencode" && formData.opencodeAutoSpawn)
    const processArgs = managedDsh ? [] : tokenizeShellCommand(formData.processArgs)
    if (usesProcess && processArgs === null) {
      toast.error(t("argumentsInvalid"))
      return
    }
    const environment = kvRowsToObject(processEnvRows)
    const environmentNames = processEnvRows.map((row) => row.key.trim()).filter(Boolean)
    if (
      usesProcess &&
      (environmentNames.some((key) => key.includes("=") || key.includes("\0")) ||
        new Set(environmentNames).size !== environmentNames.length ||
        Object.values(environment).some((value) => value.includes("\0")))
    ) {
      toast.error(t("environmentInvalid"))
      return
    }

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

    const maxConcurrentSessions = parseOptionalPositiveInteger(formData.maxConcurrentSessions)
    if (maxConcurrentSessions === null) {
      toast.error(tManage("invalidMaxSessions"))
      return
    }
    const sessionIdleTimeout = parseOptionalPositiveInteger(formData.sessionIdleTimeoutMs)
    if (sessionIdleTimeout === null) {
      toast.error(tManage("invalidIdleTimeout"))
      return
    }

    const input: AgentEditorSaveInput = {
      name: formData.name.trim(),
      cogniaModel: formData.cogniaModel ?? null,
      protocol: formData.protocol,
      transport: formData.transport,
      description: formData.description.trim(),
      defaultPermissionMode: formData.defaultPermissionMode,
      stateIsolation: effectiveStateIsolation,
      // Complete lists every time: an emptied list is the clear.
      requireApprovalFor: formData.requireApprovalFor,
      autoApprovePatterns: formData.autoApprovePatterns,
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

    // Session limits: a value sets it; an emptied field clears a saved one on
    // edit (`null`); on create, empty simply leaves it unset (no limit).
    if (maxConcurrentSessions !== undefined) {
      input.maxConcurrentSessions = maxConcurrentSessions
    } else if (editingAgent?.maxConcurrentSessions) {
      input.maxConcurrentSessions = null
    }
    if (sessionIdleTimeout !== undefined) {
      input.sessionIdleTimeout = sessionIdleTimeout
    } else if (editingAgent?.sessionIdleTimeout) {
      input.sessionIdleTimeout = null
    }

    // The account binding only means something to the Codex runtime. On edit
    // `null` is the clear (follow the active account); on create it is unset.
    if (codexFamily) {
      if (formData.subscriptionAccountId) {
        input.subscriptionAccountId = formData.subscriptionAccountId
      } else if (editingAgent) {
        input.subscriptionAccountId = null
      }
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
          args: processArgs ?? [],
          cwd: formData.processCwd || undefined,
          env: environment,
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
        args: processArgs ?? [],
        cwd: formData.processCwd || undefined,
        env: {
          ...environment,
          ...(managedDsh && formData.networkApiKey
            ? { DEEPSEEK_API_KEY: formData.networkApiKey }
            : {}),
        },
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
      // A typed password goes to the keyring (the lifecycle service lifts it
      // out of the metadata); an empty input keeps the saved one.
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
      // Metadata updates merge with saved values; null explicitly clears the
      // username. The password is a keyring credential: a typed one replaces
      // it, and removing it is the explicit action below.
      input.metadata = {
        ...(input.metadata ?? {}),
        ...(formData.opencodeServerPassword
          ? { serverPassword: formData.opencodeServerPassword }
          : {}),
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
        piPackages: formData.piPackages,
      }
    }

    if (
      input.cogniaModel &&
      (!input.cogniaModel.providerId ||
        !input.cogniaModel.modelId ||
        !canUseCogniaModels(input as CreateExternalAgentInput))
    ) {
      toast.error(tGateway("invalid"))
      return
    }

    // Secret removals the user asked for, minus any slot a new value replaces.
    const usesServerPassword =
      formData.protocol === "opencode" || formData.protocol === "opencode-v2"
    const usesApiKey = formData.protocol === "opencode-v2" || (!launchesProcess && !managedDsh)
    const removals: ExternalAgentCredentialSlot[] = []
    if (
      editingAgentId &&
      usesServerPassword &&
      formData.clearServerPassword &&
      !formData.opencodeServerPassword
    ) {
      removals.push("serverPassword")
    }
    if (editingAgentId && usesApiKey && formData.clearApiKey && !formData.networkApiKey) {
      removals.push("apiKey")
    }

    setSubmitting(true)
    let saved = false
    try {
      saved = await onSave(input)
    } catch (error) {
      toast.error(tManage("saveFailed", { error: errorText(error) }))
    }
    if (!saved) {
      // Keep the dialog, and everything typed into it, for another try.
      setSubmitting(false)
      return
    }

    if (editingAgentId && removals.length > 0) {
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        for (const slot of removals) await lifecycle.clearCredentialSlot(editingAgentId, slot)
      } catch (error) {
        toast.error(tManage("secretClearFailed", { error: errorText(error) }))
      }
    }

    setSubmitting(false)
    onOpenChange(false)
    setFormData(DEFAULT_FORM_DATA)
    setSelectedPreset("")
  }, [
    formData,
    processEnvRows,
    selectedPreset,
    managedDsh,
    launchesProcess,
    effectiveStateIsolation,
    codexFamily,
    editingAgent,
    editingAgentId,
    onSave,
    onOpenChange,
    t,
    tManage,
    tGateway,
  ])

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
      if (preset.process?.env) setProcessEnvRows(objectToKvRows(preset.process.env))
      setFormData((current) => {
        const processCommand = preset.process?.command || current.processCommand
        const processArgs = preset.process?.args?.map(shellQuote).join(" ") || current.processArgs
        return {
          ...current,
          name: presetName(t, presetId, preset),
          protocol: preset.protocol,
          transport: preset.transport,
          processCommand,
          processArgs,
          networkEndpoint: preset.network?.endpoint || current.networkEndpoint,
          defaultPermissionMode: preset.defaultPermissionMode,
          description: presetDescription(t, presetId, preset),
          stateIsolation: defaultStateIsolationFor(
            processCommand,
            tokenizeShellCommand(processArgs) ?? []
          ),
          // An account picked for one runtime means nothing to another.
          subscriptionAccountId: null,
          ...opencodeFieldsFromMetadata(preset.metadata),
        }
      })
    },
    [setFormData, t]
  )

  const maxSessionsValue = parseOptionalPositiveInteger(formData.maxConcurrentSessions)
  const approvalsSummary =
    formData.requireApprovalFor.length + formData.autoApprovePatterns.length === 0
      ? tManage("approvalsSummaryNone")
      : tManage("approvalsSummary", {
          ask: formData.requireApprovalFor.length,
          auto: formData.autoApprovePatterns.length,
        })
  const validateApproval = (value: string) =>
    isApprovalEntryValid(value) ? null : tManage("approvalInvalid")

  return (
    <ResponsiveFormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={editingAgentId ? t("editAgent") : t("addAgent")}
      description={t("agentConfigDescription")}
      testid="agent-editor"
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={() => handleOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button disabled={submitting} aria-busy={submitting} onClick={() => void handleSave()}>
            {submitting ? (
              <>
                <Spinner className="size-4" />
                {tManage("saving")}
              </>
            ) : editingAgentId ? (
              tCommon("save")
            ) : (
              tCommon("add")
            )}
          </Button>
        </>
      }
    >
      {/* One disabled fieldset freezes every control (inputs, selects,
          switches, section toggles) while the save is in flight. */}
      <fieldset
        disabled={submitting}
        className="m-0 grid min-w-0 content-start gap-3 border-0 p-0"
        data-testid="agent-editor-fields"
      >
        {setupHint && (
          <p
            className="rounded-md border p-3 text-xs text-muted-foreground"
            data-testid="preset-setup-hint"
          >
            {setupHint}
          </p>
        )}
        {/* Quick start preset — only shown when creating, not when editing,
            to avoid silently overwriting hand-tuned fields. */}
        {!editingAgentId && (
          <div className="grid gap-2" data-testid="preset-picker">
            <Label htmlFor={fid("preset")}>{t("quickStartPreset")}</Label>
            <Select value={selectedPreset || "custom"} onValueChange={handlePresetChange}>
              <SelectTrigger id={fid("preset")}>
                <SelectValue placeholder={t("selectPresetOrCustom")} />
              </SelectTrigger>
              <SelectContent>
                {getRunnablePresets().map((presetId) => {
                  const preset = getPresetConfig(presetId)
                  if (!preset) return null
                  return (
                    <SelectItem key={presetId} value={presetId}>
                      <div className="flex items-center gap-2">
                        <span>{presetName(t, presetId, preset)}</span>
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
          <Label htmlFor={fid("name")}>{t("agentName")}</Label>
          <Input
            id={fid("name")}
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder={t("agentNamePlaceholder")}
          />
        </div>

        {/* Description — what tells two configurations of one runtime apart
            when the user reads the list, so it is a first-class field. */}
        <div className="grid gap-2">
          <Label htmlFor={fid("description")}>{tManage("description")}</Label>
          <Textarea
            id={fid("description")}
            rows={2}
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder={tManage("descriptionPlaceholder")}
          />
        </div>

        {/* Protocol + transport share a row — they are one decision in
            practice, and pairing them halves the dialog's vertical budget.
            OpenCode owns its transport (HTTP+SSE), so the picker is hidden
            there instead of offering a choice the adapter ignores. The row
            wraps by its own width (the dialog, or a phone's drawer). */}
        <div className="flex flex-wrap gap-3">
          <div className="grid min-w-[12rem] flex-1 gap-2">
            <Label htmlFor={fid("protocol")}>{t("protocol")}</Label>
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
              <SelectTrigger id={fid("protocol")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {externalProtocolOptions(formData.protocol).map((option) => (
                  <SelectItem key={option.value} value={option.value} disabled={!option.selectable}>
                    {option.value === "opencode-v2" ? t("opencodeV2Protocol") : option.label}
                    {option.reasonKey ? ` — ${tManager(option.reasonKey)}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {formData.protocol !== "opencode" && formData.protocol !== "opencode-v2" && (
            <div className="grid min-w-[12rem] flex-1 gap-2">
              <Label htmlFor={fid("transport")}>{t("transport")}</Label>
              <Select
                value={formData.transport}
                onValueChange={(v) =>
                  setFormData({ ...formData, transport: v as AgentFormData["transport"] })
                }
                disabled={managedDsh || formData.protocol === "codex-app-server"}
              >
                <SelectTrigger id={fid("transport")} data-testid="transport-select">
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
            <Surface className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={fid("opencode-auto-spawn")} className="cursor-pointer text-sm">
                  {tManager("autoSpawnServer")}
                </Label>
                <p className="text-xs text-muted-foreground">{tManager("autoSpawnServerHint")}</p>
              </div>
              <Switch
                id={fid("opencode-auto-spawn")}
                checked={formData.opencodeAutoSpawn}
                onCheckedChange={(v) => setFormData({ ...formData, opencodeAutoSpawn: v })}
              />
            </Surface>
            {formData.opencodeAutoSpawn ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor={fid("opencode-command")}>{t("command")}</Label>
                  <Input
                    id={fid("opencode-command")}
                    value={formData.processCommand}
                    onChange={(e) => setFormData({ ...formData, processCommand: e.target.value })}
                    // i18n-exempt: example CLI command, not UI prose
                    placeholder="opencode"
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <div className="grid min-w-[10rem] flex-1 gap-2">
                    <Label htmlFor={fid("opencode-port")}>{tManager("serverPort")}</Label>
                    <Input
                      id={fid("opencode-port")}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={formData.opencodePort}
                      onChange={(e) => setFormData({ ...formData, opencodePort: e.target.value })}
                      // i18n-exempt: example port number, not UI prose
                      placeholder="0"
                    />
                  </div>
                  <div className="grid min-w-[10rem] flex-1 gap-2">
                    <Label htmlFor={fid("opencode-hostname")}>{tManager("serverHostname")}</Label>
                    <Input
                      id={fid("opencode-hostname")}
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
                <Label htmlFor={fid("opencode-endpoint")}>{t("endpoint")}</Label>
                <Input
                  id={fid("opencode-endpoint")}
                  value={formData.networkEndpoint}
                  onChange={(e) => setFormData({ ...formData, networkEndpoint: e.target.value })}
                  // i18n-exempt: example URL, not UI prose
                  placeholder="http://127.0.0.1:4096"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              <div className="grid min-w-[10rem] flex-1 gap-2">
                <Label htmlFor={fid("opencode-server-password")}>
                  {tManager("serverPassword")}
                </Label>
                <Input
                  id={fid("opencode-server-password")}
                  type="password"
                  autoComplete="new-password"
                  value={formData.opencodeServerPassword}
                  onChange={(e) =>
                    setFormData({ ...formData, opencodeServerPassword: e.target.value })
                  }
                  // i18n-exempt: masked-value glyphs, not UI prose
                  placeholder="••••••••"
                />
                {editingAgentId ? (
                  <SavedSecretState
                    saved={serverPasswordSaved}
                    pendingRemoval={formData.clearServerPassword}
                    onPendingRemovalChange={(next) =>
                      setFormData((current) => ({ ...current, clearServerPassword: next }))
                    }
                    testid="opencode-server-password"
                  />
                ) : null}
              </div>
              <div className="grid min-w-[10rem] flex-1 gap-2">
                <Label htmlFor={fid("opencode-server-username")}>
                  {tManager("serverUsername")}
                </Label>
                <Input
                  id={fid("opencode-server-username")}
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
              <Label htmlFor={fid("opencode-model")}>{tManager("defaultModel")}</Label>
              <Input
                id={fid("opencode-model")}
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
            {/* The preset's own setup hint already sits at the top. */}
            {!setupHint && (
              <p className="text-xs text-muted-foreground">{t("opencodeV2PresetSetupHint")}</p>
            )}
            <div className="grid gap-2">
              <Label htmlFor={fid("opencode-v2-endpoint")}>{t("endpoint")}</Label>
              <Input
                id={fid("opencode-v2-endpoint")}
                value={formData.networkEndpoint}
                onChange={(e) => setFormData({ ...formData, networkEndpoint: e.target.value })}
                placeholder={t("opencodeV2EndpointPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("opencodeV2EndpointHint")}</p>
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="grid min-w-[10rem] flex-1 gap-2">
                <Label htmlFor={fid("opencode-v2-server-password")}>
                  {tManager("serverPassword")}
                </Label>
                <Input
                  id={fid("opencode-v2-server-password")}
                  type="password"
                  autoComplete="new-password"
                  value={formData.opencodeServerPassword}
                  onChange={(e) =>
                    setFormData({ ...formData, opencodeServerPassword: e.target.value })
                  }
                  // i18n-exempt: masked-value glyphs, not UI prose
                  placeholder="••••••••"
                />
                {editingAgentId ? (
                  <SavedSecretState
                    saved={serverPasswordSaved}
                    pendingRemoval={formData.clearServerPassword}
                    onPendingRemovalChange={(next) =>
                      setFormData((current) => ({ ...current, clearServerPassword: next }))
                    }
                    testid="opencode-v2-server-password"
                  />
                ) : null}
              </div>
              <div className="grid min-w-[10rem] flex-1 gap-2">
                <Label htmlFor={fid("opencode-v2-server-username")}>
                  {tManager("serverUsername")}
                </Label>
                <Input
                  id={fid("opencode-v2-server-username")}
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
              <Label htmlFor={fid("opencode-v2-api-key")}>{t("apiKey")}</Label>
              <Input
                id={fid("opencode-v2-api-key")}
                type="password"
                autoComplete="new-password"
                value={formData.networkApiKey}
                onChange={(e) => setFormData({ ...formData, networkApiKey: e.target.value })}
                placeholder={t("apiKeyPlaceholder")}
              />
              {editingAgentId ? (
                <SavedSecretState
                  saved={apiKeySaved}
                  pendingRemoval={formData.clearApiKey}
                  onPendingRemovalChange={(next) =>
                    setFormData((current) => ({ ...current, clearApiKey: next }))
                  }
                  testid="opencode-v2-api-key"
                />
              ) : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor={fid("opencode-v2-cwd")}>{t("workingDirectory")}</Label>
              <Input
                id={fid("opencode-v2-cwd")}
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
                    <Label htmlFor={fid("dsh-api-key")}>{t("apiKey")}</Label>
                    <Input
                      id={fid("dsh-api-key")}
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
                  <Label htmlFor={fid("command")}>{t("command")}</Label>
                  <Input
                    id={fid("command")}
                    disabled={managedDsh}
                    value={formData.processCommand}
                    onChange={(e) => setFormData({ ...formData, processCommand: e.target.value })}
                    // i18n-exempt: example CLI command, not UI prose
                    placeholder="npx @anthropics/claude-code"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={fid("args")}>{t("arguments")}</Label>
                  <Input
                    id={fid("args")}
                    disabled={managedDsh}
                    value={formData.processArgs}
                    onChange={(e) => setFormData({ ...formData, processArgs: e.target.value })}
                    // i18n-exempt: example CLI arguments, not UI prose
                    placeholder="--stdio --model claude-sonnet"
                  />
                  <p className="text-xs text-muted-foreground">{t("argumentsHint")}</p>
                </div>
                {environmentLabel && (
                  <KvEditor
                    label={environmentLabel}
                    maskValues
                    rows={processEnvRows}
                    onChange={setProcessEnvRows}
                    keyPlaceholder={t("aiderEnvironmentKey")}
                    valuePlaceholder={t("aiderEnvironmentValue")}
                  />
                )}
                <div className="grid gap-2">
                  <Label htmlFor={fid("cwd")}>{t("workingDirectory")}</Label>
                  <div className="flex gap-2">
                    <Input
                      id={fid("cwd")}
                      value={formData.processCwd}
                      onChange={(e) => setFormData({ ...formData, processCwd: e.target.value })}
                      placeholder={t("cwdPlaceholder")}
                    />
                    {/* The path is this device's: an external agent spawns
                        through a local process, so there is nothing to
                        browse without a native picker and the input is the
                        control. The button used to render regardless and do
                        nothing at all when clicked. */}
                    {localPaths && directoryPicker.available && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="touch-hit shrink-0"
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
                  <Label htmlFor={fid("endpoint")}>{t("endpoint")}</Label>
                  <Input
                    id={fid("endpoint")}
                    value={formData.networkEndpoint}
                    onChange={(e) => setFormData({ ...formData, networkEndpoint: e.target.value })}
                    // i18n-exempt: example URL, not UI prose
                    placeholder="https://api.example.com/agent"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={fid("api-key")}>{t("apiKey")}</Label>
                  <Input
                    id={fid("api-key")}
                    type="password"
                    autoComplete="new-password"
                    value={formData.networkApiKey}
                    onChange={(e) => setFormData({ ...formData, networkApiKey: e.target.value })}
                    placeholder={t("apiKeyPlaceholder")}
                  />
                  {editingAgentId ? (
                    <SavedSecretState
                      saved={apiKeySaved}
                      pendingRemoval={formData.clearApiKey}
                      onPendingRemovalChange={(next) =>
                        setFormData((current) => ({ ...current, clearApiKey: next }))
                      }
                      testid="api-key"
                    />
                  ) : null}
                </div>
              </>
            )}
          </FormSection>
        )}

        {launchesProcess && !environmentLabel && (
          <FormSection title={t("processEnvironment")} dataTestId="process-environment-section">
            <p className="text-xs text-muted-foreground">{t("processEnvironmentHint")}</p>
            <KvEditor
              label={t("processEnvironment")}
              maskValues
              rows={processEnvRows}
              onChange={setProcessEnvRows}
              keyPlaceholder={t("aiderEnvironmentKey")}
              valuePlaceholder={t("aiderEnvironmentValue")}
            />
          </FormSection>
        )}

        {/* Where this configuration keeps its runtime state (ADR-0216). The
            field disables "own state" with the reason for a runtime that has
            no home variable, and says there is nothing to isolate for an agent
            that runs elsewhere. */}
        <StateIsolationField
          value={effectiveStateIsolation}
          onChange={(stateIsolation) => setFormData((current) => ({ ...current, stateIsolation }))}
          command={isolationCommand}
          args={isolationArgs}
          disabled={submitting}
          showSignInWarning={movingToOwnState}
        />

        {codexFamily && (
          <SubscriptionAccountField
            id={fid("subscription-account")}
            value={formData.subscriptionAccountId}
            onChange={(subscriptionAccountId) =>
              setFormData((current) => ({ ...current, subscriptionAccountId }))
            }
          />
        )}

        <CogniaModelPicker
          config={{
            protocol: formData.protocol,
            transport: formData.transport,
            process: {
              command: formData.processCommand || (formData.opencodeAutoSpawn ? "opencode" : ""),
              args: tokenizeShellCommand(formData.processArgs) ?? [],
            },
            network:
              formData.transport !== "stdio" && !formData.opencodeAutoSpawn
                ? { endpoint: formData.networkEndpoint }
                : undefined,
            metadata: {
              ...(selectedPreset
                ? getPresetConfig(selectedPreset)?.metadata
                : editingAgent
                  ? editingAgent.metadata
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
          <Label htmlFor={fid("permission-mode")}>{t("defaultPermissionMode")}</Label>
          <Select
            value={adaptPermissionMode(formData.defaultPermissionMode, formData.protocol).mode}
            onValueChange={(v) =>
              setFormData({ ...formData, defaultPermissionMode: v as AcpPermissionMode })
            }
          >
            <SelectTrigger id={fid("permission-mode")}>
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

        {/* Approval rules — enforced on every permission request the agent
            sends to Cognia (`configuredApprovalPolicy`). */}
        <FormSection
          title={tManage("sectionApprovals")}
          summary={approvalsSummary}
          dataTestId="approvals-section"
        >
          <p className="text-xs text-muted-foreground">{tManage("approvalsIntro")}</p>
          <p className="text-xs text-muted-foreground" data-testid="approval-syntax">
            {tManage("approvalSyntax")}
          </p>
          {adaptPermissionMode(formData.defaultPermissionMode, formData.protocol).mode ===
            "bypassPermissions" && (
            <p
              role="status"
              className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
              data-testid="approval-bypass-note"
            >
              {tManage("approvalBypassNote")}
            </p>
          )}
          <div className="grid gap-2" data-testid="require-approval-field">
            <span className="text-sm font-medium">{tManage("requireApprovalFor")}</span>
            <p className="text-xs text-muted-foreground">{tManage("requireApprovalForHint")}</p>
            <ChipInput
              values={formData.requireApprovalFor}
              onCommit={(requireApprovalFor) =>
                setFormData((current) => ({ ...current, requireApprovalFor }))
              }
              placeholder={tManage("approvalPlaceholder")}
              ariaLabel={tManage("requireApprovalFor")}
              addLabel={tManage("approvalAdd")}
              removeLabel={tManage("approvalRemove")}
              validate={validateApproval}
            />
          </div>
          <div className="grid gap-2" data-testid="auto-approve-field">
            <span className="text-sm font-medium">{tManage("autoApprove")}</span>
            <p className="text-xs text-muted-foreground">{tManage("autoApproveHint")}</p>
            <ChipInput
              values={formData.autoApprovePatterns}
              onCommit={(autoApprovePatterns) =>
                setFormData((current) => ({ ...current, autoApprovePatterns }))
              }
              placeholder={tManage("approvalPlaceholder")}
              ariaLabel={tManage("autoApprove")}
              addLabel={tManage("approvalAdd")}
              removeLabel={tManage("approvalRemove")}
              validate={validateApproval}
            />
          </div>
        </FormSection>

        {/* Does this build reach the web on its own?
            Nothing in the wire protocol answers it — it is a property of the
            binary and plan the user installed — so every manifest row ships
            `unknown` and this is where it stops being unknown. It decides
            whether Cognia supplies `web_search` for the turn
            (`lib/chat/web-access.ts`). */}
        <div className="grid gap-2">
          <Label htmlFor={fid("declared-web-search")}>{t("declaredWebSearch")}</Label>
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
            <SelectTrigger id={fid("declared-web-search")} data-testid="declared-web-search">
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
              <Label htmlFor={fid("codex-sandbox-mode")}>{t("codexSandboxMode")}</Label>
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
                <SelectTrigger id={fid("codex-sandbox-mode")} data-testid="codex-sandbox-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="readOnly">{t("codexSandboxReadOnly")}</SelectItem>
                  <SelectItem value="workspaceWrite">{t("codexSandboxWorkspaceWrite")}</SelectItem>
                  <SelectItem value="dangerFullAccess">
                    {t("codexSandboxDangerFullAccess")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.codexSandboxMode !== "dangerFullAccess" && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <Label htmlFor={fid("codex-network-access")}>{t("codexNetworkAccess")}</Label>
                  <p className="text-sm text-muted-foreground">{t("codexNetworkAccessDesc")}</p>
                </div>
                <Switch
                  id={fid("codex-network-access")}
                  checked={formData.codexNetworkAccess}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, codexNetworkAccess: checked })
                  }
                />
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              <div className="grid min-w-[10rem] flex-1 gap-2">
                <Label htmlFor={fid("codex-default-effort")}>{t("codexDefaultEffort")}</Label>
                <Select
                  value={formData.codexDefaultEffort || "model-default"}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      codexDefaultEffort: v === "model-default" ? "" : v,
                    })
                  }
                >
                  <SelectTrigger
                    id={fid("codex-default-effort")}
                    data-testid="codex-default-effort"
                  >
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
              <div className="grid min-w-[10rem] flex-1 gap-2">
                <Label htmlFor={fid("codex-reasoning-summary")}>{t("codexReasoningSummary")}</Label>
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
                  <SelectTrigger
                    id={fid("codex-reasoning-summary")}
                    data-testid="codex-reasoning-summary"
                  >
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={fid("codex-extra-skill-roots")}>{t("codexExtraSkillRoots")}</Label>
                {/* Same reasoning as the working-directory button above: the
                    textarea beside it is the control on a shell with no
                    picker, and this used to render inert. */}
                {localPaths && directoryPicker.available && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="touch-hit"
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
                id={fid("codex-extra-skill-roots")}
                data-testid="codex-skill-roots"
                value={formData.codexExtraSkillRoots}
                onChange={(e) => setFormData({ ...formData, codexExtraSkillRoots: e.target.value })}
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
              <Label htmlFor={fid("pi-extension-policy")}>{t("piExtensionPolicyLabel")}</Label>
              <Select
                value={formData.piExtensionPolicy}
                onValueChange={(v) =>
                  setFormData({
                    ...formData,
                    piExtensionPolicy: v as PiExtensionPolicy,
                  })
                }
              >
                <SelectTrigger id={fid("pi-extension-policy")} data-testid="pi-extension-policy">
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
            <PiPluginPackagesField
              value={formData.piPackages}
              onChange={(piPackages) => setFormData({ ...formData, piPackages })}
            />
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

        {/* Session limits (ADR-0216): how many sessions stay open, and how
            long a running turn may sit silent. Both empty by default. */}
        <FormSection
          title={tManage("sectionSessions")}
          dataTestId="sessions-section"
          summary={
            typeof maxSessionsValue === "number"
              ? tManage("sessionsSummaryLimited", { count: maxSessionsValue })
              : tManage("sessionsSummaryUnlimited")
          }
        >
          <div className="grid gap-2">
            <Label htmlFor={fid("max-sessions")}>{tManage("maxSessions")}</Label>
            <Input
              id={fid("max-sessions")}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={formData.maxConcurrentSessions}
              onChange={(e) => setFormData({ ...formData, maxConcurrentSessions: e.target.value })}
              placeholder={tManage("maxSessionsPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{tManage("maxSessionsHint")}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={fid("idle-timeout")}>{tManage("idleTimeout")}</Label>
            <Input
              id={fid("idle-timeout")}
              type="number"
              inputMode="numeric"
              min={1000}
              step={1000}
              value={formData.sessionIdleTimeoutMs}
              onChange={(e) => setFormData({ ...formData, sessionIdleTimeoutMs: e.target.value })}
              placeholder={tManage("idleTimeoutPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{tManage("idleTimeoutHint")}</p>
          </div>
        </FormSection>

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
          <div className="flex flex-wrap gap-3">
            <div className="grid min-w-[10rem] flex-1 gap-2">
              <Label htmlFor={fid("timeout-ms")}>{t("executionTimeoutMs")}</Label>
              <Input
                id={fid("timeout-ms")}
                type="number"
                inputMode="numeric"
                min={1000}
                step={1000}
                value={formData.timeoutMs}
                onChange={(e) => setFormData({ ...formData, timeoutMs: e.target.value })}
                placeholder={DEFAULT_TIMEOUT_MS}
              />
            </div>
            <div className="grid min-w-[10rem] flex-1 gap-2">
              <Label htmlFor={fid("retry-max-retries")}>{t("maxRetries")}</Label>
              <Input
                id={fid("retry-max-retries")}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={formData.retryMaxRetries}
                onChange={(e) => setFormData({ ...formData, retryMaxRetries: e.target.value })}
                placeholder={DEFAULT_RETRY_MAX_RETRIES}
              />
            </div>
            <div className="grid min-w-[10rem] flex-1 gap-2">
              <Label htmlFor={fid("retry-delay-ms")}>{t("retryDelayMs")}</Label>
              <Input
                id={fid("retry-delay-ms")}
                type="number"
                inputMode="numeric"
                min={0}
                step={100}
                value={formData.retryDelayMs}
                onChange={(e) => setFormData({ ...formData, retryDelayMs: e.target.value })}
                placeholder={DEFAULT_RETRY_DELAY_MS}
              />
            </div>
            <div className="grid min-w-[10rem] flex-1 gap-2">
              <Label htmlFor={fid("retry-max-delay-ms")}>{t("maxRetryDelayMs")}</Label>
              <Input
                id={fid("retry-max-delay-ms")}
                type="number"
                inputMode="numeric"
                min={0}
                step={100}
                value={formData.retryMaxDelayMs}
                onChange={(e) => setFormData({ ...formData, retryMaxDelayMs: e.target.value })}
                placeholder={DEFAULT_RETRY_MAX_DELAY_MS}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={fid("retry-backoff")}>{t("backoffStrategy")}</Label>
            <Select
              value={formData.retryExponentialBackoff ? "true" : "false"}
              onValueChange={(value) =>
                setFormData({ ...formData, retryExponentialBackoff: value === "true" })
              }
            >
              <SelectTrigger id={fid("retry-backoff")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">{t("backoffExponential")}</SelectItem>
                <SelectItem value="false">{t("backoffFixedDelay")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={fid("retry-on-errors")}>{t("retryErrorPatterns")}</Label>
            <Textarea
              id={fid("retry-on-errors")}
              rows={2}
              value={formData.retryOnErrors}
              onChange={(e) => setFormData({ ...formData, retryOnErrors: e.target.value })}
              placeholder={t("retryErrorPatternsPlaceholder")}
            />
          </div>
        </FormSection>
      </fieldset>
    </ResponsiveFormDialog>
  )
}
