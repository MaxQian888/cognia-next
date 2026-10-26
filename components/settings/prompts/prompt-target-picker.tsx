"use client"

/**
 * Where an override is written (ADR-0236 §4 "Target/scope"). Only the scopes
 * the definition declares are offered, and a workspace, agent or session
 * target is chosen by name here; the picker never defaults to whichever
 * workspace or chat happens to be on screen.
 */

import { useLiveQuery } from "dexie-react-hooks"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listResolvedCharacters } from "@/lib/db/characters"
import { listSessions } from "@/lib/db/sessions"
import type { PromptScope, PromptTargetRef } from "@/lib/prompts/types"
import { useProjectStore } from "@/stores/project/project-store"
import { usePromptLabels } from "./use-prompt-labels"

/** Sessions offered as targets, most recently active first. */
const SESSION_TARGET_LIMIT = 100

export interface PromptTargetOption {
  id: string
  label: string
}

/** The local targets of one scope, for the picker and the profile import's mapping. */
export function usePromptTargetOptions(scope: PromptScope): PromptTargetOption[] | undefined {
  const projects = useProjectStore((state) => state.projects)
  const characters = useLiveQuery(
    () => (scope === "agent" ? listResolvedCharacters() : Promise.resolve([])),
    [scope]
  )
  const sessions = useLiveQuery(
    () => (scope === "session" ? listSessions() : Promise.resolve([])),
    [scope]
  )
  switch (scope) {
    case "account":
      return []
    case "workspace":
      return projects
        .filter((project) => !project.isArchived)
        .map((project) => ({ id: project.id, label: project.name }))
    case "agent":
      return characters?.map((character) => ({ id: character.id, label: character.name }))
    case "session":
      return sessions
        ?.filter((session) => !session.archivedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, SESSION_TARGET_LIMIT)
        .map((session) => ({ id: session.id, label: session.title || session.id }))
  }
}

export interface PromptTargetPickerProps {
  scopes: readonly PromptScope[]
  scope: PromptScope
  targetId: string
  onChange(target: PromptTargetRef): void
}

export function PromptTargetPicker({ scopes, scope, targetId, onChange }: PromptTargetPickerProps) {
  const { t } = usePromptLabels()
  const options = usePromptTargetOptions(scope)

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="prompt-target-picker">
      <Select
        value={scope}
        onValueChange={(next) => onChange({ scope: next as PromptScope, targetId: "" })}
      >
        <SelectTrigger className="h-8 w-[150px] text-xs" aria-label={t("target.scope")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {scopes.map((candidate) => (
            <SelectItem key={candidate} value={candidate} className="text-xs">
              {t(`scope.${candidate}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {scope === "account" ? null : (
        <Select value={targetId} onValueChange={(next) => onChange({ scope, targetId: next })}>
          <SelectTrigger
            className="h-8 min-w-[200px] max-w-[320px] text-xs"
            aria-label={t("target.target")}
          >
            <SelectValue placeholder={t(`target.choose.${scope}`)} />
          </SelectTrigger>
          <SelectContent>
            {(options ?? []).map((option) => (
              <SelectItem key={option.id} value={option.id} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {scope !== "account" && options !== undefined && options.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">{t(`target.none.${scope}`)}</span>
      ) : null}
    </div>
  )
}
