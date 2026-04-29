"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { useLiveQuery } from "dexie-react-hooks"
import { listPresets } from "@/lib/db/prompt-presets"
import { getCharacter } from "@/lib/db/characters"
import { listSkillsByIds } from "@/lib/db/skills"
import { updateSession } from "@/lib/db/sessions"
import type { ChatSession } from "@/lib/claude/types"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { UIMessage } from "ai"
import {
  CircleDollarSignIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { avatarColor, avatarGlyph } from "@/lib/avatar"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { useEffect, useMemo, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { hasApiKey } from "@/lib/claude/ipc"
import { Badge } from "@/components/ui/badge"

const MODEL_PRESETS = [
  { value: "default", label: "Default (use global)" },
  { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "custom", label: "Custom" },
]

interface Props {
  session: ChatSession
  messages: UIMessage[]
  onOpenSettings?: () => void
}

export function ChatHeader({ session, messages, onOpenSettings }: Props) {
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
  const [model, setModel] = useState(session.model ?? "")
  const [systemPrompt, setSystemPrompt] = useState(session.systemPrompt ?? "")
  const [workingDir, setWorkingDir] = useState(session.workingDir ?? "")
  const [presetId, setPresetId] = useState<string>("")

  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setModel(session.model ?? "")
    setSystemPrompt(session.systemPrompt ?? "")
    setWorkingDir(session.workingDir ?? "")
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
      .catch(() => {
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
      title: "Working directory for this session",
    })
    if (typeof picked === "string") setWorkingDir(picked)
  }

  const handleSave = async () => {
    await updateSession(session.id, {
      model: model.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      workingDir: workingDir.trim() || undefined,
    })
    setOpen(false)
  }

  const modelSelectValue = (() => {
    if (!model) return "default"
    if (MODEL_PRESETS.some((m) => m.value === model)) return model
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
            {session.title || "(untitled)"}
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
              await updateSession(session.id, {
                disabledSkillIds: [...current],
              })
            }}
          />
        )}
        {keyOk === false && (
          <Badge variant="destructive" className="cursor-pointer gap-1" onClick={onOpenSettings}>
            <KeyRoundIcon className="size-3" />
            No API key
          </Badge>
        )}
      </div>

      {usage && (
        <div className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
          <CircleDollarSignIcon className="size-3.5" />
          <span title={`Input ${usage.inputTokens ?? 0} · Output ${usage.outputTokens ?? 0}`}>
            {formatTokens(usage.inputTokens ?? 0)} in / {formatTokens(usage.outputTokens ?? 0)} out
          </span>
          {usage.totalCostUsd !== undefined && (
            <span className="font-mono">· ${usage.totalCostUsd.toFixed(4)}</span>
          )}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Session settings">
            <Settings2Icon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96">
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-semibold">Session settings</h4>
              <p className="text-xs text-muted-foreground">
                Override defaults for this chat. Empty = use global.
              </p>
            </div>
            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="session-model" className="text-xs">
                Model
              </Label>
              <Select
                value={modelSelectValue}
                onValueChange={(v) => {
                  if (v === "default") setModel("")
                  else if (v === "custom") setModel(model || "")
                  else setModel(v)
                }}
              >
                <SelectTrigger id="session-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PRESETS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelSelectValue === "custom" && (
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="claude-..."
                  className="font-mono text-xs"
                />
              )}
            </div>

            {presets.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="session-preset" className="text-xs">
                  Apply a system-prompt preset
                </Label>
                <Select
                  value={presetId}
                  onValueChange={(v) => {
                    setPresetId(v)
                    if (v === "__none__") {
                      setSystemPrompt("")
                      return
                    }
                    const p = presets.find((x) => x.id === v)
                    if (p) setSystemPrompt(p.content)
                  }}
                >
                  <SelectTrigger id="session-preset">
                    <SelectValue placeholder="(none)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">(none)</SelectItem>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="session-system" className="text-xs">
                System prompt
              </Label>
              <Textarea
                id="session-system"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Empty = use global default"
                rows={4}
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="session-workdir" className="text-xs">
                Working directory
              </Label>
              <div className="flex gap-2">
                <Input
                  id="session-workdir"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="/path/to/project"
                  className="text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handlePickDir}
                  disabled={!isTauri()}
                  type="button"
                  aria-label="Pick directory"
                >
                  <FolderOpenIcon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave}>
                Save
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </header>
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
  const activeCount = skills.length - disabled.size
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          variant={activeCount === 0 ? "outline" : "secondary"}
          className="cursor-pointer gap-1"
          aria-label="Skills active in this session"
        >
          <SparklesIcon className="size-3" />
          {activeCount}/{skills.length} skills
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">Skills</p>
          <p className="text-[11px] text-muted-foreground">
            Toggle skills off for this session only. Edit the character to change them permanently.
          </p>
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
                  aria-label={`Toggle ${sk.name}`}
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
