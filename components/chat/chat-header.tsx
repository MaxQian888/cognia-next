"use client"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  useCharacter,
  usePresets,
  useSkillsByIds,
  useUpdateSession,
  useRecordPresetUsage,
} from "@/lib/data-hooks/context"
import {
  buildPresetApplicationPlan,
  detectPresetConflicts,
  type ApplyPresetStrategy,
} from "@/lib/presets/apply-to-session"
import { groupPresets } from "@/lib/presets/group-presets"
import { ChatHeaderPresetPill } from "@/components/chat/chat-header-preset-pill"
import { usePlatform } from "@/hooks/use-platform"
import type { AppSettings, ChatSession, SystemPromptPreset } from "@/lib/claude/types"
import {
  FolderOpenIcon,
  GitBranchIcon,
  KeyRoundIcon,
  Settings2Icon,
  SparklesIcon,
  StarIcon,
  XIcon,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { HeaderAccountSwitcher } from "./header-account-switcher"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { isTauri } from "@/lib/tauri"
import { closeSession, hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
import { Badge } from "@/components/ui/badge"
import { SingleExportTrigger } from "@/components/chat/dialogs/single-export-trigger"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TwinHeaderBadge } from "@/components/chat/twin-header-badge"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"
import { forkSessionFromParent } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { toast } from "sonner"
import { loggers } from "@/lib/logging"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

const MODEL_PRESETS: {
  value: string
  labelKey: "default" | "opus47" | "opus45" | "sonnet45" | "haiku45" | "custom"
}[] = [
  { value: "default", labelKey: "default" },
  { value: "claude-opus-4-7", labelKey: "opus47" },
  { value: "claude-opus-4-5", labelKey: "opus45" },
  { value: "claude-sonnet-4-5", labelKey: "sonnet45" },
  { value: "claude-haiku-4-5", labelKey: "haiku45" },
  { value: "custom", labelKey: "custom" },
]

const PERMISSION_MODES: NonNullable<AppSettings["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]

interface Props {
  session: ChatSession
  onOpenSettings?: () => void
}

interface PendingPresetApply {
  preset: SystemPromptPreset
  /** Fields the preset would overwrite. Always non-empty when this is set. */
  conflicts: Array<keyof FormState>
  /**
   * Where the apply lands. `"form"` writes to the settings-popover form
   * (user still has to hit Save). `"session"` skips the form and patches
   * the ChatSession directly — used by the active-preset pill, which
   * lives outside the settings popover.
   */
  mode: "form" | "session"
}

interface FormState {
  model: string
  systemPrompt: string
  workingDir: string
  permissionMode: AppSettings["permissionMode"]
  bareMode: boolean
  debugMode: boolean
  briefMode: boolean
}

export function ChatHeader({ session, onOpenSettings }: Props) {
  const t = useTranslations("chat.header")
  const updateSession = useUpdateSession()
  const recordPresetUsage = useRecordPresetUsage()
  const presetsRaw = usePresets()
  const presets = useMemo(() => presetsRaw ?? [], [presetsRaw])
  const character = useCharacter(session.characterId)
  const skills = useSkillsByIds(character?.skillIds)
  const disabledSkillIds = useMemo(
    () => new Set(session.disabledSkillIds ?? []),
    [session.disabledSkillIds]
  )
  const [open, setOpen] = useState(false)
  const [keyOk, setKeyOk] = useState<boolean | null>(null)

  // Form state, hydrated from the active session whenever the popover opens.
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
  // via `touchSession`; `setSdkSessionId` writes the SDK id; presets
  // liveQuery refreshes on any presets-table write) and would clobber the
  // user's in-progress edits — that's the "I typed a new working dir, hit
  // save, and got the old value back" bug.
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
    // Prefer `session.activePresetId` (the canonical pointer written by the
    // pill / config Popover); fall back to a content-equality match so
    // legacy sessions still surface the right active preset in the picker.
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

  // Periodically check auth status (useful for the badge). "Configured"
  // means EITHER a direct Anthropic API key OR a subscription OAuth bearer
  // (ADR-0025 — `subscription_set_active` pushes the bearer, not an api key),
  // so subscription-reuse users don't see a bogus "No API key" badge.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    Promise.all([
      hasApiKey().catch((err) => {
        loggers.chat.warn("hasApiKey check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        return false
      }),
      hasOauthBearer().catch((err) => {
        loggers.chat.warn("hasOauthBearer check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        return false
      }),
    ]).then(([key, bearer]) => {
      if (!cancelled) setKeyOk(key || bearer)
    })
    return () => {
      cancelled = true
    }
  }, [open])

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
    setOpen(false)
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
      setPendingApply({ preset, conflicts, mode: "form" })
      return
    }
    applyPresetWithStrategy(preset, "fill-empty")
  }

  /**
   * Apply a preset's payload directly to the ChatSession, bypassing the
   * settings-popover form. Invoked by the active-preset pill — the pill
   * lives outside the popover so there's no in-progress form to write to.
   */
  const applyPresetDirectlyToSession = async (
    preset: SystemPromptPreset,
    strategy: ApplyPresetStrategy
  ) => {
    const plan = buildPresetApplicationPlan(
      preset,
      {
        systemPrompt: session.systemPrompt,
        model: session.model,
        permissionMode: session.permissionMode,
        workingDir: session.workingDir,
      },
      strategy
    )
    try {
      await updateSession(session.id, {
        ...plan.sessionPatch,
        activePresetId: preset.id,
      })
      void recordPresetUsage(preset.id).catch((err) => {
        loggers.chat.warn("recordPresetUsage failed", {
          presetId: preset.id,
          err: err instanceof Error ? err.message : String(err),
        })
      })
    } catch (err) {
      loggers.chat.error("applyPresetDirectlyToSession failed", err, {
        sessionId: session.id,
        presetId: preset.id,
      })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePillPresetSelect = (preset: SystemPromptPreset) => {
    const conflicts = detectPresetConflicts(preset, {
      systemPrompt: session.systemPrompt,
      model: session.model,
      permissionMode: session.permissionMode,
      workingDir: session.workingDir,
    })
    if (conflicts.length > 0) {
      setPendingApply({ preset, conflicts, mode: "session" })
      return
    }
    void applyPresetDirectlyToSession(preset, "fill-empty")
  }

  const platform = usePlatform()
  const manageHref = platform === "mobile" ? "/me/presets" : "/settings?section=presets"

  // Group presets for the Select: favorites first, then by category.
  const presetGroups = useMemo(() => groupPresets(presets), [presets])

  const modelSelectValue = (() => {
    if (!form.model) return "default"
    if (MODEL_PRESETS.some((m) => m.value === form.model)) return form.model
    return "custom"
  })()

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
      <div className="flex flex-1 items-center gap-2 truncate">
        {character && (
          <Avatar className="size-7 shrink-0" title={character.name}>
            <AvatarFallback
              className="text-xs text-white"
              style={{ backgroundColor: avatarColor(character) }}
              aria-hidden
            >
              {avatarGlyph(character)}
            </AvatarFallback>
          </Avatar>
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium" title={session.title}>
            {session.title || t("untitledSession")}
          </span>
          {character && (
            <span
              className="truncate text-[11px] text-muted-foreground"
              title={character.description}
            >
              {character.name}
              {character.description ? ` · ${character.description}` : ""}
            </span>
          )}
        </div>
        {(session.model || character?.model) && (
          <Badge variant="secondary" className="font-mono text-[10px]">
            {session.model || character?.model}
          </Badge>
        )}
        {presets.length > 0 && (
          <ChatHeaderPresetPill
            session={session}
            presets={presets}
            onSelectPreset={handlePillPresetSelect}
            manageHref={manageHref}
          />
        )}
        <HeaderAccountSwitcher
          session={session}
          characterProviderId={character?.providerId}
          characterAccountIdOverride={character?.accountIdOverride}
        />
        {character?.twinId && (
          <TwinHeaderBadge twinId={character.twinId} twinSettings={character.twinSettings} />
        )}
        {(skills?.length ?? 0) > 0 && (
          <SkillsBadge
            skills={skills ?? []}
            disabled={disabledSkillIds}
            onToggle={async (skillId, nextDisabled) => {
              const current = new Set(session.disabledSkillIds ?? [])
              if (nextDisabled) current.add(skillId)
              else current.delete(skillId)
              try {
                await updateSession(session.id, {
                  disabledSkillIds: [...current],
                })
              } catch (err) {
                loggers.chat.error("toggle skill failed", err, {
                  sessionId: session.id,
                  skillId,
                  nextDisabled,
                })
                throw err
              }
            }}
          />
        )}
        {keyOk === false && (
          <Badge variant="destructive" className="cursor-pointer gap-1" onClick={onOpenSettings}>
            <KeyRoundIcon className="size-3" />
            {t("noApiKey")}
          </Badge>
        )}
      </div>

      <SessionCostBadgeLive
        sessionId={session.id}
        tokensLabel={(input, output) => t("tokensLabel", { input, output })}
      />

      <SingleExportTrigger session={session} />

      {session.sdkSessionId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleFork()}
              aria-label={t("forkAria")}
            >
              <GitBranchIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("forkTooltip")}</TooltipContent>
        </Tooltip>
      )}

      <PluginExtensionSlot point="chat.header" className="flex items-center gap-1 empty:hidden" />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("ariaSettings")}>
            <Settings2Icon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-semibold">{t("title")}</h4>
              <p className="text-xs text-muted-foreground">{t("description")}</p>
            </div>
            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="session-model" className="text-xs">
                {t("modelLabel")}
              </Label>
              <Select
                value={modelSelectValue}
                onValueChange={(v) => {
                  if (v === "default") setForm((f) => ({ ...f, model: "" }))
                  else if (v === "custom") setForm((f) => ({ ...f, model: f.model || "" }))
                  else setForm((f) => ({ ...f, model: v }))
                }}
              >
                <SelectTrigger id="session-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PRESETS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {t(`modelPresets.${m.labelKey}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelSelectValue === "custom" && (
                <Input
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder={t("modelCustomPlaceholder")}
                  className="font-mono text-xs"
                />
              )}
            </div>

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

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button size="sm" onClick={handleSave}>
                {t("save")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {pendingApply && (
        <PresetConflictDialog
          preset={pendingApply.preset}
          conflicts={pendingApply.conflicts}
          onCancel={() => setPendingApply(null)}
          onConfirm={(strategy) => {
            if (pendingApply.mode === "session") {
              void applyPresetDirectlyToSession(pendingApply.preset, strategy)
            } else {
              applyPresetWithStrategy(pendingApply.preset, strategy)
            }
            setPendingApply(null)
          }}
        />
      )}
    </header>
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

interface SkillsBadgeProps {
  skills: { id: string; name: string; description?: string }[]
  disabled: Set<string>
  onToggle: (skillId: string, nextDisabled: boolean) => Promise<void>
}

function SkillsBadge({ skills, disabled, onToggle }: SkillsBadgeProps) {
  const t = useTranslations("chat.header.skills")
  const activeCount = skills.length - disabled.size
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          variant={activeCount === 0 ? "outline" : "secondary"}
          className="cursor-pointer gap-1"
          aria-label={t("aria")}
        >
          <SparklesIcon className="size-3" />
          {t("counter", { active: activeCount, total: skills.length })}
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] space-y-2 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">{t("title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-col gap-2">
          {skills.map((sk) => {
            const isDisabled = disabled.has(sk.id)
            return (
              <label key={sk.id} className="flex items-start justify-between gap-3 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{sk.name}</span>
                  {sk.description && (
                    <span className="block text-[11px] text-muted-foreground">
                      {sk.description}
                    </span>
                  )}
                </span>
                <Switch
                  checked={!isDisabled}
                  onCheckedChange={(v) => void onToggle(sk.id, !v)}
                  aria-label={t("toggleAria", { name: sk.name })}
                />
              </label>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
