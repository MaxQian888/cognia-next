"use client"

/**
 * Structured payload editor for `agent-team` tasks. Runs a whole AgentTeam to
 * terminal via `agentTeamManager.start` (ADR-0022).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import type { AgentTeamDraft } from "./types"

export interface TeamPayloadEditorProps {
  draft: AgentTeamDraft
  onDraftChange: (next: AgentTeamDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
  /** Injectable list for tests (bypasses the team store). */
  teamsForTesting?: Array<{ id: string; name: string }>
}

export function TeamPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "team-payload-editor",
  teamsForTesting,
}: TeamPayloadEditorProps) {
  const t = useTranslations("scheduler")
  const [teams, setTeams] = useState<Array<{ id: string; name: string }> | null>(
    teamsForTesting ?? null
  )

  useEffect(() => {
    if (teamsForTesting) return
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return
        try {
          setTeams(agentTeamManager.list().map((tm) => ({ id: tm.id, name: tm.name })))
        } catch {
          setTeams([])
        }
      })
      .catch(() => {
        if (!cancelled) setTeams([])
      })
    return () => {
      cancelled = true
    }
  }, [teamsForTesting])

  function update<K extends keyof AgentTeamDraft>(key: K, value: AgentTeamDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  const hasTeams = (teams?.length ?? 0) > 0

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.agentTeam.teamId")} <span className="text-destructive">*</span>
        </Label>
        {hasTeams ? (
          <Select
            value={draft.teamId || "__none__"}
            onValueChange={(v) => update("teamId", v === "__none__" ? "" : v)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn("h-10", errors?.teamId && "border-destructive")}
              data-testid={`${testId}-team-select`}
            >
              <SelectValue placeholder={t("payload.agentTeam.teamIdPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("payload.agentTeam.teamIdPlaceholder")}</SelectItem>
              {(teams ?? []).map((tm) => (
                <SelectItem key={tm.id} value={tm.id}>
                  {tm.name}{" "}
                  <span className="text-xs text-muted-foreground font-mono">({tm.id})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={draft.teamId}
            onChange={(e) => update("teamId", e.target.value)}
            placeholder={t("payload.agentTeam.teamIdPlaceholder")}
            disabled={disabled}
            className={cn("h-10 font-mono text-sm", errors?.teamId && "border-destructive")}
            data-testid={`${testId}-team-input`}
          />
        )}
        {errors?.teamId && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.teamId}`)}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("payload.agentTeam.persistenceHelp")}</p>
      </div>

      <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
        <div>
          <Label className="text-sm font-medium">{t("payload.agentTeam.ultracode")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {t("payload.agentTeam.ultracodeHelp")}
          </p>
        </div>
        <Switch
          checked={draft.ultracode}
          onCheckedChange={(v) => update("ultracode", v)}
          disabled={disabled}
          data-testid={`${testId}-ultracode-switch`}
        />
      </div>
    </div>
  )
}
