"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listResolvedCharacters } from "@/lib/db/characters"

/** Select sentinel for "no default agent" (Radix Select has no empty value). */
const NO_DEFAULT = "__none__"

interface Props {
  /** The workspace's `defaultCharacterId`, `""` for none. */
  value: string
  onChange: (next: string) => void
}

/**
 * Picks the agent a person's new conversations in this workspace start as
 * (`Project.defaultCharacterId`). Variants are listed like any other agent,
 * which is how one repository gets its own configuration of a shared agent.
 * A saved default that no longer resolves stays visible as missing instead of
 * silently reading "none".
 */
export function WorkspaceDefaultAgentField({ value, onChange }: Props) {
  const t = useTranslations("workspace.manage")
  const agents = useLiveQuery(() => listResolvedCharacters(), [])
  const missing = useMemo(
    () => Boolean(value) && agents !== undefined && !agents.some((agent) => agent.id === value),
    [agents, value]
  )
  return (
    <div className="space-y-2">
      <Label htmlFor="workspace-default-agent">{t("defaultAgentLabel")}</Label>
      <Select
        value={value || NO_DEFAULT}
        onValueChange={(v) => onChange(v === NO_DEFAULT ? "" : v)}
      >
        <SelectTrigger id="workspace-default-agent" aria-label={t("defaultAgentLabel")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT}>{t("defaultAgentNone")}</SelectItem>
          {missing ? (
            <SelectItem value={value}>{t("defaultAgentMissing", { id: value })}</SelectItem>
          ) : null}
          {(agents ?? []).map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        className={
          missing
            ? "text-xs leading-relaxed text-destructive"
            : "text-xs leading-relaxed text-muted-foreground"
        }
        data-testid="workspace-default-agent-hint"
      >
        {missing ? t("defaultAgentMissingHint") : t("defaultAgentHint")}
      </p>
    </div>
  )
}
