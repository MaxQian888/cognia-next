"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, GitBranchIcon, SparklesIcon, StarIcon, XIcon } from "lucide-react"
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
import { SingleExportTrigger } from "@/components/chat/dialogs/single-export-trigger"
import { ClearConversationTrigger } from "@/components/chat/dialogs/clear-conversation-trigger"
import { isTauri } from "@/lib/tauri"
import { closeSession } from "@/lib/claude/ipc"
import { forkSessionFromParent } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { loggers } from "@/lib/logging"
import { toast } from "sonner"
import type { AppSettings, ChatSession, SystemPromptPreset } from "@/lib/claude/types"

const PERMISSION_MODES: NonNullable<AppSettings["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]

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

  const [form, setForm] = useState<FormState>({
    model: session.model ?? "",
    systemPrompt: session.systemPrompt ?? "",
    workingDir: session.workingDir ?? "",
    permissionMode: session.permissionMode,
    bareMode: Boolean(session.bareMode),
    debugMode: Boolean(session.debugMode),
    briefMode: Boolean(session.briefMode),
  })
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
    })
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

  const handleFork = async () => {
    try {
      const fork = await forkSessionFromParent(session.id)
      useChatStore.getState().setActiveSession(fork.id)
      toast.success(t("forkSuccess"))
      loggers.chat.info("session.forked", {
        parentSessionId: session.id,
        parentSdkSessionId: session.sdkSessionId,
        forkId: fork.id,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg)
      loggers.chat.warn("session.fork failed", { sessionId: session.id, err: msg })
    }
  }

  const handleSave = async () => {
    const prevWorkingDir = session.workingDir ?? ""
    const newWorkingDir = form.workingDir.trim()
    try {
      await updateSession(session.id, {
        model: form.model.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        workingDir: newWorkingDir || undefined,
        permissionMode: form.permissionMode,
        bareMode: form.bareMode || undefined,
        debugMode: form.debugMode || undefined,
        briefMode: form.briefMode || undefined,
        activePresetId: presetId || undefined,
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
                  {PERMISSION_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
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
              {!form.workingDir && character?.workingDir && (
                <p className="text-[11px] text-muted-foreground">
                  {t("cwdFallbackHint", { path: character.workingDir })}
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
              <SingleExportTrigger session={session} variant="labeled" />
              <ClearConversationTrigger />
              {session.sdkSessionId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleFork()}
                  aria-label={t("forkAria")}
                  className="gap-1.5"
                >
                  <GitBranchIcon className="size-4" />
                  {t("forkTooltip")}
                </Button>
              )}
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
