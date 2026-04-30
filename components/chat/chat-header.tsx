"use client"

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
import { useLiveQuery } from "dexie-react-hooks"
import { listPresets, recordPresetUsage } from "@/lib/db/prompt-presets"
import { getCharacter } from "@/lib/db/characters"
import { listSkillsByIds } from "@/lib/db/skills"
import { updateSession } from "@/lib/db/sessions"
import {
  buildPresetApplicationPlan,
  type ApplyPresetStrategy,
} from "@/lib/presets/apply-to-session"
import { PRESET_CATEGORIES } from "@/lib/presets/categories"
import type { AppSettings, ChatSession, SystemPromptPreset } from "@/lib/claude/types"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { UIMessage } from "ai"
import {
  CircleDollarSignIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  Settings2Icon,
  SparklesIcon,
  StarIcon,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { isTauri } from "@/lib/tauri"
import { hasApiKey } from "@/lib/claude/ipc"
import { Badge } from "@/components/ui/badge"
import { SingleExportTrigger } from "@/components/chat/dialogs/single-export-trigger"
import { loggers } from "@/lib/logger"

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
  messages: UIMessage[]
  onOpenSettings?: () => void
}

interface PendingPresetApply {
  preset: SystemPromptPreset
  /** Fields the preset would overwrite. Always non-empty when this is set. */
  conflicts: Array<keyof FormState>
}

interface FormState {
  model: string
  systemPrompt: string
  workingDir: string
  permissionMode: AppSettings["permissionMode"]
}

export function ChatHeader({ session, messages, onOpenSettings }: Props) {
  const t = useTranslations("chat.header")
  const presetsRaw = useLiveQuery(() => listPresets(), [])
  const presets = useMemo(() => presetsRaw ?? [], [presetsRaw])
  const character = useLiveQuery(
    () => (session.characterId ? getCharacter(session.characterId) : Promise.resolve(undefined)),
    [session.characterId]
  )
  const skills = useLiveQuery(
    () => (character?.skillIds?.length ? listSkillsByIds(character.skillIds) : Promise.resolve([])),
    [character?.skillIds?.join(",") ?? ""]
  )
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
  })
  const [presetId, setPresetId] = useState<string>("")
  const [pendingApply, setPendingApply] = useState<PendingPresetApply | null>(null)

  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setForm({
      model: session.model ?? "",
      systemPrompt: session.systemPrompt ?? "",
      workingDir: session.workingDir ?? "",
      permissionMode: session.permissionMode,
    })
    // Match preset by content if any.
    const matched = presets.find((p) => p.content === session.systemPrompt)
    setPresetId(matched?.id ?? "")
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, session, presets])

  // Periodically check API key status (useful for the badge).
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    hasApiKey()
      .then((ok) => {
        if (!cancelled) setKeyOk(ok)
      })
      .catch((err) => {
        loggers.chat.warn("hasApiKey check failed", {
          err: err instanceof Error ? err.message : String(err),
        })
        if (!cancelled) setKeyOk(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const usage = useMemo(() => aggregateUsage(messages), [messages])

  const handlePickDir = async () => {
    if (!isTauri()) return
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("pickDirTitle"),
    })
    if (typeof picked === "string") setForm((f) => ({ ...f, workingDir: picked }))
  }

  const handleSave = async () => {
    try {
      await updateSession(session.id, {
        model: form.model.trim() || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
        workingDir: form.workingDir.trim() || undefined,
        permissionMode: form.permissionMode,
      })
    } catch (err) {
      loggers.chat.error("session settings save failed", err, { sessionId: session.id })
      throw err
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
    const conflicts: Array<keyof FormState> = []
    if (form.systemPrompt.trim() && preset.content) conflicts.push("systemPrompt")
    if (form.model.trim() && preset.model) conflicts.push("model")
    if (form.permissionMode && preset.permissionMode) conflicts.push("permissionMode")
    if (form.workingDir.trim() && preset.workingDir) conflicts.push("workingDir")
    if (conflicts.length > 0) {
      setPendingApply({ preset, conflicts })
      return
    }
    applyPresetWithStrategy(preset, "fill-empty")
  }

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
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs"
            style={{
              backgroundColor: avatarColor(character),
              color: "white",
            }}
            aria-hidden
            title={character.name}
          >
            {avatarGlyph(character)}
          </span>
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

      {usage && (
        <div className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
          <CircleDollarSignIcon className="size-3.5" />
          <span title={`Input ${usage.inputTokens ?? 0} · Output ${usage.outputTokens ?? 0}`}>
            {t("tokensLabel", {
              input: formatTokens(usage.inputTokens ?? 0),
              output: formatTokens(usage.outputTokens ?? 0),
            })}
          </span>
          {usage.totalCostUsd !== undefined && (
            <span className="font-mono">· ${usage.totalCostUsd.toFixed(4)}</span>
          )}
        </div>
      )}

      <SingleExportTrigger session={session} />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("ariaSettings")}>
            <Settings2Icon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96">
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
            applyPresetWithStrategy(pendingApply.preset, strategy)
            setPendingApply(null)
          }}
        />
      )}
    </header>
  )
}

interface PresetGroup {
  /** Either a translation sub-key (when `translateLabel` is true) or a verbatim category id. */
  label: string
  /** When true, `label` is a key inside the `chat.header.groups.*` namespace. */
  translateLabel?: boolean
  presets: SystemPromptPreset[]
}

/**
 * Group presets for the chat-header dropdown: favorites first, then default
 * (if not already in favorites), then by category, then everything else.
 */
function groupPresets(presets: SystemPromptPreset[]): PresetGroup[] {
  const groups: PresetGroup[] = []
  const seen = new Set<string>()

  const favorites = presets.filter((p) => p.isFavorite && !seen.has(p.id))
  if (favorites.length > 0) {
    groups.push({ label: "favorites", translateLabel: true, presets: favorites })
    favorites.forEach((p) => seen.add(p.id))
  }

  const defaults = presets.filter((p) => p.isDefault && !seen.has(p.id))
  if (defaults.length > 0) {
    groups.push({ label: "default", translateLabel: true, presets: defaults })
    defaults.forEach((p) => seen.add(p.id))
  }

  for (const cat of PRESET_CATEGORIES) {
    const inCat = presets.filter((p) => p.category === cat.id && !seen.has(p.id))
    if (inCat.length > 0) {
      groups.push({ label: cat.id, presets: inCat })
      inCat.forEach((p) => seen.add(p.id))
    }
  }

  const rest = presets.filter((p) => !seen.has(p.id))
  if (rest.length > 0) {
    groups.push({ label: "other", translateLabel: true, presets: rest })
  }
  return groups
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
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

function aggregateUsage(messages: UIMessage[]): UsageInfo | null {
  const totals: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
  }
  let any = false
  for (const m of messages) {
    const meta = (m as { metadata?: { usage?: UsageInfo } }).metadata
    const u = meta?.usage
    if (!u) continue
    any = true
    totals.inputTokens! += u.inputTokens ?? 0
    totals.outputTokens! += u.outputTokens ?? 0
    totals.cacheReadInputTokens! += u.cacheReadInputTokens ?? 0
    totals.cacheCreationInputTokens! += u.cacheCreationInputTokens ?? 0
    totals.totalCostUsd! += u.totalCostUsd ?? 0
  }
  return any ? totals : null
}
