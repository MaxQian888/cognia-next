"use client"

/**
 * Assignee picker — the one control that produces an `IssueActor`.
 *
 * Options are the local human ("Me"), every `Character` (→ `agent` actor,
 * which is exactly the id `createAgentTask` needs), and every `AgentTeam`
 * (→ `team` actor). External agents are deliberately NOT offered: the run
 * adapters cannot dispatch to them, and an assignee that cannot be run is a
 * dead affordance (`types/issues/index.ts`, `IssueActor`).
 *
 * The value is the `actorKey` string (`human:self`, `agent:<id>`, `team:<id>`)
 * so it round-trips through a `Select` without a second encoding, and the
 * chosen actor carries a `label` snapshot so the board renders it without a
 * join (matching how `Issue.assignee.label` is documented).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { actorKey } from "@/lib/issues/board-model"
import { SELF_ACTOR_KEY } from "@/lib/issues/run/running"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { IssueActor } from "@/types/issues"

/** `Select` cannot hold an empty string, so "unassigned" gets a sentinel. */
export const UNASSIGNED_VALUE = "none"

export interface AssigneeOption {
  key: string
  actor: IssueActor
  group: "human" | "agent" | "team"
}

/** Build the picker's option list from Characters and AgentTeams. */
export function buildAssigneeOptions(
  characters: ReadonlyArray<{ id: string; name: string }>,
  teams: ReadonlyArray<{ id: string; name: string }>,
  meLabel: string
): AssigneeOption[] {
  const options: AssigneeOption[] = [
    { key: SELF_ACTOR_KEY, actor: { kind: "human", label: meLabel }, group: "human" },
  ]
  for (const character of characters) {
    const actor: IssueActor = { kind: "agent", id: character.id, label: character.name }
    options.push({ key: actorKey(actor)!, actor, group: "agent" })
  }
  for (const team of teams) {
    const actor: IssueActor = { kind: "team", id: team.id, label: team.name }
    options.push({ key: actorKey(actor)!, actor, group: "team" })
  }
  return options
}

/** Resolve a picker value back to an actor (or `null` for unassigned). */
export function actorForValue(
  value: string,
  options: readonly AssigneeOption[]
): IssueActor | null | undefined {
  if (value === UNASSIGNED_VALUE) return null
  return options.find((option) => option.key === value)?.actor
}

export interface AssigneePickerProps {
  id?: string
  value: IssueActor | null | undefined
  onChange: (actor: IssueActor | null) => void
  disabled?: boolean
  "data-testid"?: string
}

export function AssigneePicker({
  id,
  value,
  onChange,
  disabled,
  "data-testid": testId = "issue-assignee-picker",
}: AssigneePickerProps) {
  const t = useTranslations("issues")
  const characters = useClientLiveQuery(() => listCharacters(), [], [])
  const teamsById = useAgentTeamStore((state) => state.teams)
  const workspaceId = useProjectStore((state) => state.activeProjectId)

  const options = useMemo(() => {
    const teams = Object.values(teamsById)
      // Teams are workspace-scoped; a team from another workspace cannot be
      // dispatched from this board.
      .filter((team) => !workspaceId || !team.projectId || team.projectId === workspaceId)
      .map((team) => ({ id: team.id, name: team.name }))
    return buildAssigneeOptions(
      (characters ?? []).map((character) => ({ id: character.id, name: character.name })),
      teams,
      t("actor.human")
    )
  }, [characters, teamsById, workspaceId, t])

  const currentKey = actorKey(value ?? undefined) ?? UNASSIGNED_VALUE
  // A stored assignee whose Character/team was since deleted still needs a
  // visible row, or the Select silently shows nothing.
  const known = options.some((option) => option.key === currentKey)
  const groups: Array<{ group: AssigneeOption["group"]; label: string }> = [
    { group: "human", label: t("actor.human") },
    { group: "agent", label: t("assignee.agents") },
    { group: "team", label: t("assignee.teams") },
  ]

  return (
    <Select
      value={currentKey}
      disabled={disabled}
      onValueChange={(next) => {
        const actor = actorForValue(next, options)
        if (actor === undefined) return
        onChange(actor)
      }}
    >
      <SelectTrigger id={id} data-testid={testId} aria-label={t("detail.assignee")}>
        <SelectValue placeholder={t("actor.unassigned")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED_VALUE} data-testid={`${testId}-none`}>
          {t("actor.unassigned")}
        </SelectItem>
        {!known && value ? (
          <SelectItem value={currentKey} data-testid={`${testId}-stale`}>
            {value.label ?? t(`actor.${value.kind}`)} · {t("assignee.missing")}
          </SelectItem>
        ) : null}
        {groups.map(({ group, label }) => {
          const rows = options.filter((option) => option.group === group)
          if (rows.length === 0) return null
          return (
            <SelectGroup key={group}>
              <SelectLabel>{label}</SelectLabel>
              {rows.map((option) => (
                <SelectItem
                  key={option.key}
                  value={option.key}
                  data-testid={`${testId}-${option.key}`}
                >
                  {option.actor.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
      </SelectContent>
    </Select>
  )
}
