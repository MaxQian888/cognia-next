"use client"

/**
 * Structured payload editor for chat / agent / skill scheduled tasks. Wraps
 * the smaller leaf editors (tool-picker, mcp-picker, builtin-tools-toggles,
 * permission-mode-select, additional-directories-list) and exposes the full
 * `ChatLikeDraft` to the parent via a controlled-component contract.
 *
 * Required-field handling per task type:
 *   - chat            → prompt
 *   - agent           → prompt + characterId
 *   - skill           → prompt + skillId
 *
 * Per-task-type errors come in via the `errors` prop so the parent can surface
 * the same validation messages consistently across structured / JSON modes.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChevronDown, ChevronUp } from "lucide-react"
import { listCharacters } from "@/lib/db/characters"
import { listSkills } from "@/lib/db/skills"
import { listTeams } from "@/lib/db/teams"
import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import type { Character, Skill, Team, SendOptions } from "@/lib/claude/types"
import type { ScheduledTaskType } from "@/types/scheduler"
import { cn } from "@/lib/utils"
import { ToolPicker } from "./tool-picker"
import { McpPicker } from "./mcp-picker"
import { BuiltinToolsToggles } from "./builtin-tools-toggles"
import { PermissionModeSelect } from "./permission-mode-select"
import { AdditionalDirectoriesList } from "./additional-directories-list"
import type { ChatLikeDraft } from "./types"

const SENTINEL_RUNTIME = "__runtime__"
const SENTINEL_NONE = "__none__"
const SENTINEL_EFFORT_DEFAULT = "__default__"

const EFFORTS: NonNullable<SendOptions["effort"]>[] = ["low", "medium", "high", "xhigh", "max"]

export interface ChatPayloadEditorProps {
  taskType: ScheduledTaskType
  draft: ChatLikeDraft
  onDraftChange: (next: ChatLikeDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string

  // Test seams — when provided, skip the Dexie fetches.
  charactersForTesting?: Character[]
  skillsForTesting?: Skill[]
  teamsForTesting?: Team[]
}

export function ChatPayloadEditor({
  taskType,
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "chat-payload-editor",
  charactersForTesting,
  skillsForTesting,
  teamsForTesting,
}: ChatPayloadEditorProps) {
  const t = useTranslations("scheduler")
  const [characters, setCharacters] = useState<Character[] | null>(charactersForTesting ?? null)
  const [skills, setSkills] = useState<Skill[] | null>(skillsForTesting ?? null)
  const [teams, setTeams] = useState<Team[] | null>(teamsForTesting ?? null)
  const customModes = useCustomModeStore((s) => Object.values(s.customModes))

  useEffect(() => {
    if (charactersForTesting) return
    let cancelled = false
    listCharacters()
      .then((rows) => {
        if (!cancelled) setCharacters(rows)
      })
      .catch(() => {
        if (!cancelled) setCharacters([])
      })
    return () => {
      cancelled = true
    }
  }, [charactersForTesting])

  useEffect(() => {
    if (skillsForTesting) return
    let cancelled = false
    listSkills()
      .then((rows) => {
        if (!cancelled) setSkills(rows)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [skillsForTesting])

  useEffect(() => {
    if (teamsForTesting) return
    let cancelled = false
    listTeams()
      .then((rows) => {
        if (!cancelled) setTeams(rows)
      })
      .catch(() => {
        if (!cancelled) setTeams([])
      })
    return () => {
      cancelled = true
    }
  }, [teamsForTesting])

  function update<K extends keyof ChatLikeDraft>(key: K, value: ChatLikeDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  // ---- Mode select sentinel mapping -----------------------------------------
  const modeSelectValue =
    draft.agentModeId === undefined
      ? SENTINEL_RUNTIME
      : draft.agentModeId === null
        ? SENTINEL_NONE
        : draft.agentModeId

  function setMode(value: string) {
    if (value === SENTINEL_RUNTIME) update("agentModeId", undefined)
    else if (value === SENTINEL_NONE) update("agentModeId", null)
    else update("agentModeId", value)
  }

  return (
    <div className="space-y-4" data-testid={testId}>
      {/* Prompt */}
      <div className="space-y-2">
        <Label htmlFor={`${testId}-prompt`} className="text-sm font-medium">
          {t("payload.prompt")} <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id={`${testId}-prompt`}
          value={draft.prompt}
          onChange={(e) => update("prompt", e.target.value)}
          rows={4}
          placeholder={t("payload.promptPlaceholder")}
          disabled={disabled}
          className={cn(errors?.prompt && "border-destructive focus-visible:ring-destructive/20")}
          data-testid={`${testId}-prompt-input`}
        />
        {errors?.prompt && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.prompt}`)}</p>
        )}
      </div>

      {/* Character (required for agent, optional for chat/skill) */}
      {(taskType === "agent" || taskType === "chat" || taskType === "skill") && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            {t("payload.character")}{" "}
            {taskType === "agent" && <span className="text-destructive">*</span>}
          </Label>
          <Select
            value={draft.characterId ?? "__none__"}
            onValueChange={(v) => update("characterId", v === "__none__" ? undefined : v)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn("h-10", errors?.characterId && "border-destructive")}
              data-testid={`${testId}-character-select`}
            >
              <SelectValue placeholder={t("payload.characterPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("payload.characterNone")}</SelectItem>
              {(characters ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors?.characterId && (
            <p className="text-xs text-destructive">{t(`payload.errors.${errors.characterId}`)}</p>
          )}
        </div>
      )}

      {/* Skill (required for skill type) */}
      {taskType === "skill" && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            {t("payload.skill")} <span className="text-destructive">*</span>
          </Label>
          <Select
            value={draft.skillId ?? "__none__"}
            onValueChange={(v) => update("skillId", v === "__none__" ? undefined : v)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn("h-10", errors?.skillId && "border-destructive")}
              data-testid={`${testId}-skill-select`}
            >
              <SelectValue placeholder={t("payload.skillPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("payload.skillNone")}</SelectItem>
              {(skills ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors?.skillId && (
            <p className="text-xs text-destructive">{t(`payload.errors.${errors.skillId}`)}</p>
          )}
        </div>
      )}

      {/* Agent mode */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.agentMode")}</Label>
        <Select value={modeSelectValue} onValueChange={setMode} disabled={disabled}>
          <SelectTrigger className="h-10" data-testid={`${testId}-mode-select`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SENTINEL_RUNTIME}>{t("payload.modeUseRuntime")}</SelectItem>
            <SelectItem value={SENTINEL_NONE}>{t("payload.modeNone")}</SelectItem>
            {BUILT_IN_AGENT_MODES.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}{" "}
                <span className="text-xs text-muted-foreground">({t("payload.modeBuiltIn")})</span>
              </SelectItem>
            ))}
            {customModes.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}{" "}
                <span className="text-xs text-muted-foreground">({t("payload.modeCustom")})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Model + Effort + Max turns */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.model")}</Label>
          <Input
            value={draft.model ?? ""}
            onChange={(e) => update("model", e.target.value || undefined)}
            placeholder={t("payload.modelPlaceholder")}
            disabled={disabled}
            className="h-10 font-mono text-sm"
            data-testid={`${testId}-model-input`}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.effort")}</Label>
          <Select
            value={draft.effort ?? SENTINEL_EFFORT_DEFAULT}
            onValueChange={(v) =>
              update(
                "effort",
                v === SENTINEL_EFFORT_DEFAULT ? undefined : (v as SendOptions["effort"])
              )
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-10" data-testid={`${testId}-effort-select`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SENTINEL_EFFORT_DEFAULT}>
                {t("payload.effortUseDefault")}
              </SelectItem>
              {EFFORTS.map((e) => (
                <SelectItem key={e} value={e!}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.maxTurns")}</Label>
          <Input
            type="number"
            min={1}
            max={100}
            value={draft.maxTurns ?? ""}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              update("maxTurns", Number.isFinite(n) && n > 0 ? n : undefined)
            }}
            placeholder={t("payload.maxTurnsPlaceholder")}
            disabled={disabled}
            className="h-10"
            data-testid={`${testId}-max-turns-input`}
          />
        </div>
      </div>

      {/* Team picker (chat-only — bound team session) */}
      {taskType === "chat" && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.team")}</Label>
          <Select
            value={draft.teamId ?? "__none__"}
            onValueChange={(v) => update("teamId", v === "__none__" ? undefined : v)}
            disabled={disabled}
          >
            <SelectTrigger className="h-10" data-testid={`${testId}-team-select`}>
              <SelectValue placeholder={t("payload.teamPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("payload.teamNone")}</SelectItem>
              {(teams ?? []).map((tm) => (
                <SelectItem key={tm.id} value={tm.id}>
                  {tm.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("payload.teamHelp")}</p>
        </div>
      )}

      {/* Session id (advanced — append to existing) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.sessionId")}</Label>
          <Input
            value={draft.sessionId ?? ""}
            onChange={(e) => update("sessionId", e.target.value || undefined)}
            placeholder={t("payload.sessionIdPlaceholder")}
            disabled={disabled}
            className="h-10 font-mono text-xs"
            data-testid={`${testId}-session-id-input`}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.sessionTitle")}</Label>
          <Input
            value={draft.sessionTitle ?? ""}
            onChange={(e) => update("sessionTitle", e.target.value || undefined)}
            placeholder={t("payload.sessionTitlePlaceholder")}
            disabled={disabled}
            className="h-10"
            data-testid={`${testId}-session-title-input`}
          />
        </div>
      </div>

      {/* Permission mode */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.permissionMode")}</Label>
        <PermissionModeSelect
          flavor="sdk"
          value={draft.permissionMode}
          onChange={(v) => update("permissionMode", v as SendOptions["permissionMode"] | undefined)}
          disabled={disabled}
          testId={`${testId}-permission-mode`}
        />
      </div>

      {/* Tools — collapsible */}
      <Collapsible defaultOpen={!!draft.allowedTools?.length || !!draft.disallowedTools?.length}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50"
            data-testid={`${testId}-tools-toggle`}
          >
            <span>{t("payload.tools.heading")}</span>
            <ChevronDown className="h-4 w-4" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-3 rounded-md border p-3">
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("payload.tools.allowedHeading")}</Label>
            <p className="text-xs text-muted-foreground">{t("payload.tools.allowedHelp")}</p>
            <ToolPicker
              value={draft.allowedTools}
              onChange={(v) => update("allowedTools", v)}
              disabled={disabled}
              testId={`${testId}-allowed-tools`}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("payload.tools.disallowedHeading")}</Label>
            <p className="text-xs text-muted-foreground">{t("payload.tools.disallowedHelp")}</p>
            <ToolPicker
              value={draft.disallowedTools}
              onChange={(v) => update("disallowedTools", v)}
              disabled={disabled}
              testId={`${testId}-disallowed-tools`}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* MCP servers — collapsible */}
      <Collapsible defaultOpen={draft.mcpMode === "custom"}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50"
            data-testid={`${testId}-mcp-toggle`}
          >
            <span>{t("payload.mcp.heading")}</span>
            <ChevronDown className="h-4 w-4" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-md border p-3">
          <McpPicker
            mode={draft.mcpMode}
            onModeChange={(m) => update("mcpMode", m)}
            value={draft.mcpServerIds}
            onChange={(v) => update("mcpServerIds", v)}
            disabled={disabled}
            testId={`${testId}-mcp-picker`}
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Built-in tools — collapsible */}
      <Collapsible defaultOpen={!!draft.builtinTools && Object.keys(draft.builtinTools).length > 0}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50"
            data-testid={`${testId}-builtin-tools-toggle`}
          >
            <span>{t("payload.builtinToolsHeading")}</span>
            <ChevronDown className="h-4 w-4" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-md border p-3">
          <BuiltinToolsToggles
            value={draft.builtinTools}
            onChange={(v) => update("builtinTools", v)}
            disabled={disabled}
            testId={`${testId}-builtin-tools`}
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Additional directories — collapsible */}
      <Collapsible defaultOpen={!!draft.additionalDirectories?.length}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50"
            data-testid={`${testId}-additional-dirs-toggle`}
          >
            <span>{t("payload.additionalDirectories.heading")}</span>
            <ChevronUp className="h-4 w-4" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-md border p-3">
          <AdditionalDirectoriesList
            value={draft.additionalDirectories}
            onChange={(v) => update("additionalDirectories", v)}
            disabled={disabled}
            testId={`${testId}-additional-dirs`}
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Append system prompt — collapsible */}
      <Collapsible defaultOpen={!!draft.appendSystemPrompt}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50"
            data-testid={`${testId}-append-system-toggle`}
          >
            <span>{t("payload.appendSystemPromptHeading")}</span>
            <ChevronDown className="h-4 w-4" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-md border p-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t("payload.appendSystemPromptHelp")}</p>
          <Textarea
            value={draft.appendSystemPrompt ?? ""}
            onChange={(e) => update("appendSystemPrompt", e.target.value || undefined)}
            rows={3}
            disabled={disabled}
            data-testid={`${testId}-append-system-input`}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
