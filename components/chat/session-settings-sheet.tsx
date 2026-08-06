"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChartLineIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusIcon,
  SparklesIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

import {
  useCharacter,
  usePresets,
  useRecordPresetUsage,
  useSkillsByIds,
  useUpdateSession,
} from "@/lib/data-hooks/context"
import {
  buildPresetApplicationPlan,
  detectPresetConflicts,
  type ApplyPresetStrategy,
} from "@/lib/presets/apply-to-session"
import { groupPresets } from "@/lib/presets/group-presets"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { HeaderAccountSwitcher } from "./header-account-switcher"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"
import { PlanModeTasksSheet } from "@/components/agent/workspace/plan-mode-tasks-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { TwinHeaderBadge } from "@/components/chat/twin-header-badge"
import { SkillsBadge } from "@/components/chat/skills-badge"
import { AgentFlowDisplayToggle } from "@/components/chat/agent-flow-display-toggle"
import { SessionInsightsSheet } from "@/components/chat/session-insights/session-insights-sheet"
import { SingleExportTrigger } from "@/components/chat/dialogs/single-export-trigger"
import { ClearConversationTrigger } from "@/components/chat/dialogs/clear-conversation-trigger"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { closeSession } from "@/lib/claude/ipc"
import { branchSessionAtMessage } from "@/lib/chat/branch-session"
import { selectVisibleMessages } from "@/stores/chat/chat-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { primaryRootOf } from "@/lib/workspace/roots"
import { SessionExecutionWorkspace } from "./session-execution-workspace"
import { ProjectEnvironmentManager } from "@/components/settings/project-environment-manager"
import { createSessionExecutionContext } from "@/lib/task-workspace/session-execution-context"
import { loggers } from "@cognia/logging"
import { toast } from "sonner"
import {
  PERMISSION_MODES as ALL_PERMISSION_MODES,
  permissionModeMeta,
  permissionRiskMarker,
} from "@/lib/settings/permission-mode-meta"
import {
  isValidAgentEnvName,
  resolveAgentExecutionPolicy,
  resolveAgentModel,
} from "@/lib/agent/agent-profile-policy"
import { createAgentEnvSecretRef, saveAgentEnvSecret } from "@/lib/agent/agent-env-keyring"
import type {
  AgentEnvBinding,
  AppSettings,
  ChatSession,
  SystemPromptPreset,
} from "@cognia/agent-config-types"

/**
 * Every permission mode, straight from the shared metadata rather than a local
 * list. The local list had drifted to four entries and silently omitted
 * `dontAsk` and `auto`, which only mattered once the status bar's picker (the
 * other per-session surface) was removed: this sheet is now the sole place to
 * set a power mode for one session, so an omission here would mean the mode is
 * settable app-wide but not per-session.
 */
const PERMISSION_MODES = ALL_PERMISSION_MODES as NonNullable<AppSettings["permissionMode"]>[]

interface FormState {
  /**
   * Session model. Edited via the inline composer `ModelPicker` (single source
   * of truth); kept here only as a passthrough so preset application can still
   * set it and `handleSave` can persist it unchanged.
   */
  model: string
  systemPrompt: string
  workingDir: string
  permissionMode: AppSettings["permissionMode"]
  bareMode: boolean
  debugMode: boolean
  briefMode: boolean
  executionEffort: NonNullable<ChatSession["effort"]> | "inherit"
  executionMaxTurns: string
  executionEnvBindings: AgentEnvBinding[]
}

function executionFormState(session: ChatSession) {
  return {
    executionEffort: session.effort ?? session.executionPolicy?.effort ?? ("inherit" as const),
    executionMaxTurns: session.executionPolicy?.maxTurns?.toString() ?? "",
    executionEnvBindings: (session.executionPolicy?.envBindings ?? []).map((binding) => ({
      ...binding,
    })),
  }
}

interface PendingPresetApply {
  preset: SystemPromptPreset
  /** Fields the preset would overwrite. Always non-empty when this is set. */
  conflicts: Array<keyof FormState>
}

export interface SessionSettingsSheetProps {
  session: ChatSession
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Mobile-only: render the ambient status cluster (live cost, plan-mode
   * tasks, the `chat.header` plugin slot) at the top of the sheet. On desktop
   * these live in the chat header itself, so this defaults off to avoid
   * duplicating them. The mobile shell suppresses the inner ChatHeader
   * (`showHeader={false}`) and relocates the cluster here instead.
   */
  showAmbientStatus?: boolean
}

/**
 * Low-frequency, session-scoped settings + lifecycle actions, consolidated out
 * of the chat header into a single `⚙ Session` sheet (control-surface
 * consolidation — area ①). The header owns the trigger button and passes
 * `open`/`onOpenChange`.
 */
export function SessionSettingsSheet({
  session,
  open,
  onOpenChange,
  showAmbientStatus = false,
}: SessionSettingsSheetProps) {
  const t = useTranslations("chat.header")
  const tPermission = useTranslations("chat.permissionMode")
  const [insightsOpen, setInsightsOpen] = useState(false)
  const updateSession = useUpdateSession()
  const recordPresetUsage = useRecordPresetUsage()
  const presetsRaw = usePresets()
  const presets = useMemo(() => presetsRaw ?? [], [presetsRaw])
  const character = useCharacter(session.characterId)
  const skills = useSkillsByIds(character?.skillIds)
  // Ad-hoc skills attached to the next message (composer state) so the badge
  // counter + attached section reflect the net effective set for the send.
  const ephemeralSkillIds = useChatStore((s) => s.ephemeralSkillIds)
  const ephemeralSkills = useSkillsByIds(ephemeralSkillIds)
  const disabledSkillIds = useMemo(
    () => new Set(session.disabledSkillIds ?? []),
    [session.disabledSkillIds]
  )
  const { plan } = useCredentialStatus()
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null

  // What the session actually falls back to when no per-session dir is set:
  // active workspace primary root → character default → app default (the same
  // chain resolveSendOptions applies), so the hint never contradicts a send.
  const activeProject = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )
  const defaultWorkingDir = useSettingsStore((s) => s.settings?.defaultWorkingDir)
  const fallbackCwd = resolveEffectiveCwd({
    activeProject,
    characterWorkingDir: character?.workingDir,
    defaultWorkingDir,
  })
  const activeProjectRoot = activeProject ? primaryRootOf(activeProject) : undefined

  const [form, setForm] = useState<FormState>({
    model: session.model ?? "",
    systemPrompt: session.systemPrompt ?? "",
    workingDir: session.workingDir ?? "",
    permissionMode: session.permissionMode,
    bareMode: Boolean(session.bareMode),
    debugMode: Boolean(session.debugMode),
    briefMode: Boolean(session.briefMode),
    ...executionFormState(session),
  })
  const [envSecretValues, setEnvSecretValues] = useState<Record<string, string>>({})
  const [executionEffortDirty, setExecutionEffortDirty] = useState(false)
  const [presetId, setPresetId] = useState<string>("")
  const [pendingApply, setPendingApply] = useState<PendingPresetApply | null>(null)

  // Hydrate the form ONLY on the false→true transition of `open`. A naive
  // `[open, session, presets]` deps list re-fires whenever the parent
  // re-renders with a new session reference (every send bumps `updatedAt`
  // via `touchSession`) and would clobber the user's in-progress edits —
  // that's the "I typed a new working dir, hit save, and got the old value
  // back" bug. (Regression covered by tests.)
  const prevOpenRef = useRef(false)
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (!open || wasOpen) return

    setForm({
      model: session.model ?? "",
      systemPrompt: session.systemPrompt ?? "",
      workingDir: session.workingDir ?? "",
      permissionMode: session.permissionMode,
      bareMode: Boolean(session.bareMode),
      debugMode: Boolean(session.debugMode),
      briefMode: Boolean(session.briefMode),
      ...executionFormState(session),
    })
    setEnvSecretValues({})
    setExecutionEffortDirty(false)
    let resolvedId: string | null = null
    if (session.activePresetId) {
      const byId = presets.find((p) => p.id === session.activePresetId)
      if (byId) resolvedId = byId.id
    }
    if (!resolvedId) {
      const matched = presets.find((p) => p.content === session.systemPrompt)
      resolvedId = matched?.id ?? null
    }
    setPresetId(resolvedId ?? "")
  }, [open, session, presets])

  const handlePickDir = async () => {
    if (!isTauri()) return
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("pickDirTitle"),
    })
    if (typeof picked === "string") setForm((f) => ({ ...f, workingDir: picked }))
  }

  const handleMemoryOverride = async (
    key: "memoryUse" | "memoryLearn",
    value: "inherit" | "on" | "off"
  ) => {
    await updateSession(session.id, {
      [key]: value === "inherit" ? undefined : value === "on",
    })
  }

  /**
   * Branch the whole conversation — the session-level entry to the same
   * operation the per-message branch button performs, with the last visible
   * message as the cut-off.
   *
   * This used to call `forkSessionFromParent`, a strictly weaker duplicate:
   * `branchSessionAtMessage` already reuses the cheap SDK fork when the cut-off
   * is the tail and the parent has an `sdkSessionId` (see `branch-session.ts`),
   * so the only differences were the things the old path lacked — it copied no
   * messages (leaving a blank conversation whose model nonetheless remembered
   * everything), recorded no `parentSessionId` (so no lineage chip), dropped
   * nine per-session settings, and threw an untranslated Error straight into a
   * toast on any provider without an SDK session id.
   */
  const handleBranch = async () => {
    try {
      const state = useChatStore.getState()
      const slice = state.sessions[session.id]
      const visible = slice
        ? selectVisibleMessages(slice.messages, slice.activeBranchByGroup)
        : session.id === state.activeSessionId
          ? selectVisibleMessages(state.messages, state.activeBranchByGroup)
          : []
      const cutoff = visible.at(-1)
      if (!cutoff) {
        toast.error(t("branchEmpty"))
        return
      }
      const child = await branchSessionAtMessage({
        sourceId: session.id,
        visibleMessages: visible,
        messageId: cutoff.id,
        mode: "direct",
      })
      useChatStore.getState().setActiveSession(child.id)
      toast.success(t("branchSuccess"))
      loggers.chat.info("session.branched", {
        parentSessionId: session.id,
        parentSdkSessionId: session.sdkSessionId,
        branchId: child.id,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t("branchError"))
      loggers.chat.warn("session.branch failed", { sessionId: session.id, err: msg })
    }
  }

  const handleSave = async () => {
    const prevWorkingDir = session.workingDir ?? ""
    const newWorkingDir = form.workingDir.trim()
    const maxTurnsText = form.executionMaxTurns.trim()
    const maxTurns = maxTurnsText ? Number(maxTurnsText) : undefined
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) {
      toast.error(t("execution.maxTurnsInvalid"))
      return
    }

    const envBindings = form.executionEnvBindings.map((binding) => ({
      ...binding,
      name: binding.name.trim(),
    }))
    const envNames = new Set<string>()
    for (const binding of envBindings) {
      if (!isValidAgentEnvName(binding.name)) {
        toast.error(t("execution.envNameInvalid", { name: binding.name || "?" }))
        return
      }
      if (envNames.has(binding.name)) {
        toast.error(t("execution.envNameDuplicate", { name: binding.name }))
        return
      }
      envNames.add(binding.name)
    }

    const initialSecretRefs = new Set(
      (session.executionPolicy?.envBindings ?? [])
        .filter(
          (binding): binding is Extract<AgentEnvBinding, { kind: "secret" }> =>
            binding.kind === "secret"
        )
        .map((binding) => binding.secretRef)
    )
    for (const binding of envBindings) {
      if (
        binding.kind === "secret" &&
        !initialSecretRefs.has(binding.secretRef) &&
        !envSecretValues[binding.secretRef]
      ) {
        toast.error(t("execution.envSecretRequired", { name: binding.name }))
        return
      }
    }

    try {
      for (const binding of envBindings) {
        if (binding.kind !== "secret") continue
        const value = envSecretValues[binding.secretRef]
        if (!value) continue
        try {
          await saveAgentEnvSecret(binding.secretRef, value)
        } catch (error) {
          loggers.chat.error("session environment secret save failed", error, {
            sessionId: session.id,
            name: binding.name,
          })
          toast.error(t("execution.envSecretSaveFailed", { name: binding.name }))
          return
        }
      }

      const effort = form.executionEffort === "inherit" ? undefined : form.executionEffort
      const executionPolicy =
        maxTurns !== undefined || envBindings.length > 0
          ? {
              maxTurns,
              envBindings: envBindings.length > 0 ? envBindings : undefined,
            }
          : undefined
      await updateSession(session.id, {
        model: form.model.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        workingDir: newWorkingDir || undefined,
        permissionMode: form.permissionMode,
        bareMode: form.bareMode || undefined,
        debugMode: form.debugMode || undefined,
        briefMode: form.briefMode || undefined,
        activePresetId: presetId || undefined,
        effort,
        thinkingLevel: executionEffortDirty ? effort : session.thinkingLevel,
        executionPolicy,
      })
    } catch (err) {
      loggers.chat.error("session settings save failed", err, { sessionId: session.id })
      throw err
    }
    // If the working directory changed and there's an active sidecar session,
    // close it so the next send creates a fresh session with the new cwd.
    if (newWorkingDir !== prevWorkingDir && session.sdkSessionId && isTauri()) {
      closeSession(session.id).catch((err) => {
        loggers.chat.warn("closeSession after cwd change failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }
    onOpenChange(false)
  }

  const applyPresetWithStrategy = (preset: SystemPromptPreset, strategy: ApplyPresetStrategy) => {
    const plan = buildPresetApplicationPlan(
      preset,
      {
        systemPrompt: form.systemPrompt,
        model: form.model,
        permissionMode: form.permissionMode,
        workingDir: form.workingDir,
      },
      strategy
    )
    setForm((prev) => ({
      ...prev,
      model: plan.sessionPatch.model ?? prev.model,
      systemPrompt: plan.sessionPatch.systemPrompt ?? prev.systemPrompt,
      workingDir: plan.sessionPatch.workingDir ?? prev.workingDir,
      permissionMode: plan.sessionPatch.permissionMode ?? prev.permissionMode,
    }))
    setPresetId(preset.id)
    void recordPresetUsage(preset.id).catch((err) => {
      loggers.chat.warn("recordPresetUsage failed", {
        presetId: preset.id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }

  const handlePresetSelect = (id: string) => {
    if (id === "__none__") {
      setForm((f) => ({ ...f, systemPrompt: "" }))
      setPresetId("")
      return
    }
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    const conflicts = detectPresetConflicts(preset, {
      systemPrompt: form.systemPrompt,
      model: form.model,
      permissionMode: form.permissionMode,
      workingDir: form.workingDir,
    })
    if (conflicts.length > 0) {
      setPendingApply({ preset, conflicts })
      return
    }
    applyPresetWithStrategy(preset, "fill-empty")
  }

  // Group presets for the Select: favorites first, then by category.
  const presetGroups = useMemo(() => groupPresets(presets), [presets])

  const handleSkillToggle = async (skillId: string, nextDisabled: boolean) => {
    const current = new Set(session.disabledSkillIds ?? [])
    if (nextDisabled) current.add(skillId)
    else current.delete(skillId)
    try {
      await updateSession(session.id, { disabledSkillIds: [...current] })
    } catch (err) {
      loggers.chat.error("toggle skill failed", err, {
        sessionId: session.id,
        skillId,
        nextDisabled,
      })
      throw err
    }
  }

  const effectiveExecutionSummary = useMemo(() => {
    if (!character) return null
    const policy = resolveAgentExecutionPolicy(character.executionPolicy, session.executionPolicy)
    return {
      planModel: resolveAgentModel("plan", character, undefined),
      executeModel: resolveAgentModel("execute", character, undefined),
      utilityModel: resolveAgentModel("utility", character, undefined),
      effort: session.effort ?? policy.effort,
      maxTurns: policy.maxTurns,
    }
  }, [character, session.effort, session.executionPolicy])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {/* 实时状态（仅移动端：桌面端这些在 ChatHeader 内） */}
          {showAmbientStatus && (
            <Section label={t("sheet.sections.status")}>
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="session-ambient-status"
              >
                <SessionCostBadgeLive
                  sessionId={session.id}
                  tokensLabel={(input, output) => t("tokensLabel", { input, output })}
                />
                <PlanModeTasksSheet sessionId={session.id} />
                <PluginExtensionSlot
                  point="chat.header"
                  className="flex items-center gap-1 empty:hidden"
                />
              </div>
              {effectiveExecutionSummary && (
                <div
                  className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border bg-muted/20 p-2 text-[11px] sm:grid-cols-3"
                  data-testid="agent-execution-summary"
                >
                  <ExecutionSummaryItem
                    label={t("execution.summaryPlan")}
                    value={effectiveExecutionSummary.planModel ?? t("execution.summaryDefault")}
                  />
                  <ExecutionSummaryItem
                    label={t("execution.summaryExecute")}
                    value={effectiveExecutionSummary.executeModel ?? t("execution.summaryDefault")}
                  />
                  <ExecutionSummaryItem
                    label={t("execution.summaryUtility")}
                    value={effectiveExecutionSummary.utilityModel ?? t("execution.summaryDefault")}
                  />
                  <ExecutionSummaryItem
                    label={t("execution.summaryEffort")}
                    value={
                      effectiveExecutionSummary.effort
                        ? effectiveExecutionSummary.effort
                        : t("execution.summaryDefault")
                    }
                  />
                  <ExecutionSummaryItem
                    label={t("execution.summaryMaxTurns")}
                    value={
                      effectiveExecutionSummary.maxTurns?.toString() ??
                      t("execution.summaryDefault")
                    }
                  />
                </div>
              )}
            </Section>
          )}

          {/* 模型与账号 */}
          <Section label={t("sheet.sections.account")}>
            <HeaderAccountSwitcher
              session={session}
              characterProviderId={character?.providerId}
              characterAccountIdOverride={character?.accountIdOverride}
            />
          </Section>

          {/* 行为 */}
          <Section label={t("sheet.sections.behavior")}>
            <div className="space-y-1.5">
              <Label htmlFor="session-system" className="text-xs">
                {t("systemPromptLabel")}
              </Label>
              <Textarea
                id="session-system"
                value={form.systemPrompt}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
                placeholder={t("systemPromptPlaceholder")}
                rows={4}
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="session-perm" className="text-xs">
                {t("permissionModeLabel")}
              </Label>
              <Select
                value={form.permissionMode ?? "__default__"}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    permissionMode:
                      v === "__default__" ? undefined : (v as AppSettings["permissionMode"]),
                  }))
                }
              >
                <SelectTrigger id="session-perm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">{t("permissionModeAppDefault")}</SelectItem>
                  {PERMISSION_MODES.map((m) => {
                    const marker = permissionRiskMarker(m)
                    return (
                      <SelectItem key={m} value={m}>
                        {/* Localized label + risk marker, not the raw id: this is
                            now the only per-session picker, and `⚠ Bypass` must
                            not read like any other option in the list. */}
                        <span className="flex items-center gap-1.5">
                          {marker && (
                            <span aria-hidden className={cn(marker === "⚠" && "text-rose-500")}>
                              {marker}
                            </span>
                          )}
                          {tPermission(`${permissionModeMeta(m).i18nKey}.label`)}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="session-workdir" className="text-xs">
                {t("workingDirLabel")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="session-workdir"
                  value={form.workingDir}
                  onChange={(e) => setForm((f) => ({ ...f, workingDir: e.target.value }))}
                  placeholder={t("workingDirPlaceholder")}
                  className="text-xs"
                />
                {form.workingDir && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setForm((f) => ({ ...f, workingDir: "" }))}
                    type="button"
                    aria-label={t("cwdReset")}
                  >
                    <XIcon className="size-4" />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handlePickDir}
                  disabled={!isTauri()}
                  type="button"
                  aria-label={t("pickDirAria")}
                >
                  <FolderOpenIcon className="size-4" />
                </Button>
              </div>
              {!form.workingDir && fallbackCwd && (
                <p className="text-[11px] text-muted-foreground">
                  {t("cwdFallbackHint", { path: fallbackCwd })}
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
              <SessionModeToggle
                id="session-bare-mode"
                label={t("bareMode")}
                checked={form.bareMode}
                onCheckedChange={(v) => setForm((f) => ({ ...f, bareMode: v }))}
              />
              <SessionModeToggle
                id="session-debug-mode"
                label={t("debugMode")}
                checked={form.debugMode}
                onCheckedChange={(v) => setForm((f) => ({ ...f, debugMode: v }))}
              />
              <SessionModeToggle
                id="session-brief-mode"
                label={t("briefMode")}
                checked={form.briefMode}
                onCheckedChange={(v) => setForm((f) => ({ ...f, briefMode: v }))}
              />
            </div>
          </Section>

          <Section label={t("sheet.sections.execution")}>
            <SessionExecutionWorkspace
              session={session}
              projectId={activeProject?.id}
              projectRoot={activeProjectRoot?.path}
              rootId={activeProjectRoot?.id}
              environmentId={
                session.executionContext?.environmentId ?? activeProject?.defaultEnvironmentId
              }
            />
            {activeProject && activeProjectRoot && (
              <ProjectEnvironmentManager
                projectId={activeProject.id}
                executionRoot={session.executionContext?.worktreePath ?? activeProjectRoot.path}
                scope={
                  session.executionContext?.location === "managedWorktree"
                    ? "managedWorktree"
                    : "local"
                }
                selectedEnvironmentId={
                  session.executionContext?.environmentId ?? activeProject.defaultEnvironmentId
                }
                onSelectedEnvironmentChange={async (environmentId) => {
                  const executionContext = session.executionContext
                    ? { ...session.executionContext, environmentId }
                    : createSessionExecutionContext({
                        sessionId: session.id,
                        projectId: activeProject.id,
                        projectRoot: activeProjectRoot.path,
                        rootId: activeProjectRoot.id,
                        environmentId,
                        requestedLocation: "local",
                        isGitRepository: false,
                        now: Date.now(),
                      })
                  await updateSession(session.id, { executionContext })
                }}
              />
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="session-execution-effort" className="text-xs">
                  {t("execution.effort")}
                </Label>
                <Select
                  value={form.executionEffort}
                  onValueChange={(value) => {
                    setExecutionEffortDirty(true)
                    setForm((current) => ({
                      ...current,
                      executionEffort: value as FormState["executionEffort"],
                    }))
                  }}
                >
                  <SelectTrigger id="session-execution-effort" aria-label={t("execution.effort")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{t("execution.inherit")}</SelectItem>
                    {(["low", "medium", "high", "xhigh", "max"] as const).map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {t(`execution.effortValues.${effort}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="session-execution-max-turns" className="text-xs">
                  {t("execution.maxTurns")}
                </Label>
                <Input
                  id="session-execution-max-turns"
                  type="number"
                  min={1}
                  max={100}
                  value={form.executionMaxTurns}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      executionMaxTurns: event.target.value,
                    }))
                  }
                  placeholder={t("execution.maxTurnsPlaceholder")}
                />
                <p className="text-[10px] text-muted-foreground">{t("execution.maxTurnsHint")}</p>
              </div>
            </div>

            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Label className="text-xs font-medium">{t("execution.envTitle")}</Label>
                  <p className="text-[10px] text-muted-foreground">
                    {t("execution.envDescription")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      executionEnvBindings: [
                        ...current.executionEnvBindings,
                        { name: "", kind: "plain", value: "" },
                      ],
                    }))
                  }
                >
                  <PlusIcon className="mr-1 size-3.5" />
                  {t("execution.addEnv")}
                </Button>
              </div>

              {form.executionEnvBindings.map((binding, index) => {
                const rowId = `session-env-${index}`
                return (
                  <div
                    key={binding.kind === "secret" ? binding.secretRef : `plain-${index}`}
                    className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_7.5rem_1fr_auto]"
                  >
                    <div className="space-y-1">
                      <Label className="text-xs" htmlFor={`${rowId}-name`}>
                        {t("execution.envName")}
                      </Label>
                      <Input
                        id={`${rowId}-name`}
                        value={binding.name}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            executionEnvBindings: current.executionEnvBindings.map((item, i) =>
                              i === index ? { ...item, name: event.target.value } : item
                            ),
                          }))
                        }
                        placeholder={t("execution.envNamePlaceholder")}
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("execution.envKind")}</Label>
                      <Select
                        value={binding.kind}
                        onValueChange={(kind) =>
                          setForm((current) => ({
                            ...current,
                            executionEnvBindings: current.executionEnvBindings.map((item, i) => {
                              if (i !== index || item.kind === kind) return item
                              return kind === "secret"
                                ? {
                                    name: item.name,
                                    kind: "secret" as const,
                                    secretRef: createAgentEnvSecretRef(
                                      `session-${session.id}`,
                                      item.name || "ENV"
                                    ),
                                  }
                                : { name: item.name, kind: "plain" as const, value: "" }
                            }),
                          }))
                        }
                      >
                        <SelectTrigger aria-label={t("execution.envKind")}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="plain">{t("execution.envPlain")}</SelectItem>
                          <SelectItem value="secret">{t("execution.envSecret")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs" htmlFor={`${rowId}-value`}>
                        {t("execution.envValue")}
                      </Label>
                      <Input
                        id={`${rowId}-value`}
                        type={binding.kind === "secret" ? "password" : "text"}
                        autoComplete={binding.kind === "secret" ? "new-password" : undefined}
                        value={
                          binding.kind === "secret"
                            ? (envSecretValues[binding.secretRef] ?? "")
                            : binding.value
                        }
                        onChange={(event) => {
                          if (binding.kind === "secret") {
                            setEnvSecretValues((current) => ({
                              ...current,
                              [binding.secretRef]: event.target.value,
                            }))
                            return
                          }
                          setForm((current) => ({
                            ...current,
                            executionEnvBindings: current.executionEnvBindings.map((item, i) =>
                              i === index && item.kind === "plain"
                                ? { ...item, value: event.target.value }
                                : item
                            ),
                          }))
                        }}
                        placeholder={
                          binding.kind === "secret"
                            ? t("execution.envSecretPlaceholder")
                            : t("execution.envPlainPlaceholder")
                        }
                        className="font-mono text-xs"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          executionEnvBindings: current.executionEnvBindings.filter(
                            (_, i) => i !== index
                          ),
                        }))
                      }
                      aria-label={t("execution.removeEnv", { name: binding.name || "?" })}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          </Section>

          <Section label={t("sheet.sections.memory")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="session-memory-use" className="text-xs">
                  {t("memoryUse")}
                </Label>
                <Select
                  value={
                    session.memoryUse === undefined ? "inherit" : session.memoryUse ? "on" : "off"
                  }
                  onValueChange={(value) =>
                    void handleMemoryOverride("memoryUse", value as "inherit" | "on" | "off")
                  }
                >
                  <SelectTrigger id="session-memory-use" aria-label={t("memoryUse")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{t("memoryInherit")}</SelectItem>
                    <SelectItem value="on">{t("memoryOn")}</SelectItem>
                    <SelectItem value="off">{t("memoryOff")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="session-memory-learn" className="text-xs">
                  {t("memoryLearn")}
                </Label>
                <Select
                  value={
                    session.memoryLearn === undefined
                      ? "inherit"
                      : session.memoryLearn
                        ? "on"
                        : "off"
                  }
                  onValueChange={(value) =>
                    void handleMemoryOverride("memoryLearn", value as "inherit" | "on" | "off")
                  }
                >
                  <SelectTrigger id="session-memory-learn" aria-label={t("memoryLearn")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{t("memoryInherit")}</SelectItem>
                    <SelectItem value="on">{t("memoryOn")}</SelectItem>
                    <SelectItem value="off">{t("memoryOff")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Section>

          {/* 角色与能力 */}
          {(presets.length > 0 ||
            character?.twinId ||
            (skills?.length ?? 0) > 0 ||
            (ephemeralSkills?.length ?? 0) > 0) && (
            <Section label={t("sheet.sections.role")}>
              {presets.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="session-preset" className="text-xs">
                    {t("presetLabel")}
                  </Label>
                  <Select value={presetId || "__none__"} onValueChange={handlePresetSelect}>
                    <SelectTrigger id="session-preset">
                      <SelectValue placeholder={t("presetNonePlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("presetNoneOption")}</SelectItem>
                      {presetGroups.map((group) => (
                        <SelectGroup key={group.label}>
                          <SelectLabel className="text-[10px] uppercase tracking-wider">
                            {group.translateLabel ? t(`groups.${group.label}`) : group.label}
                          </SelectLabel>
                          {group.presets.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              <span className="flex items-center gap-1.5">
                                {p.icon ?? "📌"} {p.name}
                                {p.isDefault && (
                                  <StarIcon className="size-3 fill-amber-400 text-amber-400" />
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">{t("presetHelp")}</p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {character?.twinId && (
                  <TwinHeaderBadge
                    twinId={character.twinId}
                    twinSettings={character.twinSettings}
                  />
                )}
                {((skills?.length ?? 0) > 0 || (ephemeralSkills?.length ?? 0) > 0) && (
                  <SkillsBadge
                    skills={skills ?? []}
                    disabled={disabledSkillIds}
                    onToggle={handleSkillToggle}
                    ephemeralSkills={ephemeralSkills ?? []}
                  />
                )}
              </div>
            </Section>
          )}

          {/* 显示 */}
          <Section label={t("sheet.sections.display")}>
            <div className="flex flex-wrap items-center gap-2">
              <AgentFlowDisplayToggle />
              {planLabel && (
                <Badge
                  variant="secondary"
                  className="gap-1"
                  aria-label={t("subscriptionBadgeAria", { tier: planLabel })}
                >
                  <SparklesIcon className="size-3" />
                  {t("subscriptionBadge", { tier: planLabel })}
                </Badge>
              )}
            </div>
          </Section>

          {/* 会话操作 */}
          <Section label={t("sheet.sections.actions")}>
            <div className="flex flex-wrap items-center gap-2">
              {/* Insights moved here from its own header icon. Closing this
                  sheet first avoids stacking two right-side sheets, which would
                  leave the settings one dangling behind the insights one. */}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                data-testid="session-open-insights"
                onClick={() => {
                  onOpenChange(false)
                  setInsightsOpen(true)
                }}
              >
                <ChartLineIcon className="size-4" />
                {t("insights")}
              </Button>
              <SingleExportTrigger session={session} variant="labeled" />
              <ClearConversationTrigger />
              {/* No longer gated on `sdkSessionId`: that gate existed because the
                  old SDK-level fork had nothing to fork from without one, which
                  hid this action entirely on every provider that never issues an
                  SDK session id. Branching re-establishes context from the
                  transcript when no fork is available, so it works everywhere. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleBranch()}
                aria-label={t("branchAria")}
                className="gap-1.5"
              >
                <GitBranchIcon className="size-4" />
                {t("branchTooltip")}
              </Button>
            </div>
          </Section>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" onClick={handleSave}>
            {t("save")}
          </Button>
        </SheetFooter>
      </SheetContent>

      {pendingApply && (
        <PresetConflictDialog
          preset={pendingApply.preset}
          conflicts={pendingApply.conflicts}
          onCancel={() => setPendingApply(null)}
          onConfirm={(strategy) => {
            applyPresetWithStrategy(pendingApply.preset, strategy)
            setPendingApply(null)
          }}
        />
      )}

      {/* Mounted here rather than in the chat header: the header's dedicated
          chart button is gone, and this sheet is the only thing that opens it. */}
      <SessionInsightsSheet session={session} open={insightsOpen} onOpenChange={setInsightsOpen} />
    </Sheet>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </section>
  )
}

function ExecutionSummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="break-all font-medium">{value}</span>
    </span>
  )
}

function SessionModeToggle({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="cursor-pointer text-xs">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  )
}

interface ConflictDialogProps {
  preset: SystemPromptPreset
  conflicts: Array<keyof FormState>
  onCancel: () => void
  onConfirm: (strategy: ApplyPresetStrategy) => void
}

function PresetConflictDialog({ preset, conflicts, onCancel, onConfirm }: ConflictDialogProps) {
  const t = useTranslations("chat.header.presetConflict")
  const [strategy, setStrategy] = useState<ApplyPresetStrategy>("fill-empty")
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title", { name: preset.name })}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {t("summary", { count: conflicts.length, fields: conflicts.join(", ") })}
              </p>
              <RadioGroup
                value={strategy}
                onValueChange={(v) => setStrategy(v as ApplyPresetStrategy)}
                className="gap-2"
              >
                <label className="flex items-start gap-2 rounded-md border p-2 text-xs">
                  <RadioGroupItem value="fill-empty" id="strategy-fill" className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block font-medium">{t("fillEmptyTitle")}</span>
                    <span className="block text-muted-foreground">{t("fillEmptyBody")}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-md border p-2 text-xs">
                  <RadioGroupItem value="overwrite-all" id="strategy-all" className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block font-medium">{t("overwriteAllTitle")}</span>
                    <span className="block text-muted-foreground">{t("overwriteAllBody")}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-md border p-2 text-xs">
                  <RadioGroupItem value="merge" id="strategy-merge" className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block font-medium">{t("mergeTitle")}</span>
                    <span className="block text-muted-foreground">{t("mergeBody")}</span>
                  </span>
                </label>
              </RadioGroup>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(strategy)}>{t("apply")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
