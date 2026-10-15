"use client"

import { useTranslations } from "next-intl"
import { BotIcon, ShieldAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { AgentChangeset } from "@/lib/scm/types"
import { changesetActions } from "./presentation"

interface Props {
  changeset: AgentChangeset
  selected: boolean
  onSelect: (selected: boolean) => void
  onOpen: () => void
  disabled?: boolean
}

export function ChangesetRow({ changeset, selected, onSelect, onOpen, disabled }: Props) {
  const t = useTranslations("agentChanges")
  const included = changeset.files.filter((file) => !file.excluded)
  const insertions = included.reduce((sum, file) => sum + (file.insertions ?? 0), 0)
  const deletions = included.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  return (
    <li
      className="flex items-start gap-2 rounded-md border p-3"
      data-testid={`changeset-${changeset.changesetId}`}
    >
      <Checkbox
        className="mt-1.5"
        checked={selected}
        disabled={disabled || !changesetActions(changeset.state).select}
        onCheckedChange={(checked) => onSelect(checked === true)}
        aria-label={t("selectChangeset", { title: changeset.title })}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Button
          variant="link"
          className="h-auto max-w-full justify-start whitespace-normal p-0 text-left"
          onClick={onOpen}
        >
          {changeset.title}
        </Button>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 break-all">
            <BotIcon className="size-3.5 shrink-0" aria-hidden />
            {changeset.agentId ?? changeset.agentKind ?? t("unknownAgent")}
          </span>
          <Badge variant="outline">{t(`states.${changeset.state}`)}</Badge>
          <Badge variant={changeset.review?.riskTier === "high" ? "destructive" : "secondary"}>
            {changeset.review ? t(`risk.${changeset.review.riskTier}`) : t("risk.unassessed")}
          </Badge>
          <span>{t("fileCount", { count: changeset.files.length })}</span>
          <span>{t("lineTotals", { insertions, deletions })}</span>
          {changeset.files.some((file) => file.excluded) && (
            <Badge variant="outline">
              <ShieldAlertIcon className="size-3" aria-hidden />
              {t("excluded")}
            </Badge>
          )}
        </div>
      </div>
    </li>
  )
}
