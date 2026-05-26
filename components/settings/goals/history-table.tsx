"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { listAllGoals } from "@/lib/db/goals"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function GoalsHistoryTable() {
  const t = useTranslations("goal")
  const goals = useLiveQuery(() => listAllGoals(500), [])

  if (!goals) return <p className="text-sm text-muted-foreground">{t("activity.loading")}</p>

  if (goals.length === 0) {
    return (
      <p
        className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
        data-testid="goals-history-empty"
      >
        {t("history.empty")}
      </p>
    )
  }

  return (
    <Table data-testid="goals-history-table">
      <TableHeader>
        <TableRow>
          <TableHead>{t("history.objective")}</TableHead>
          <TableHead>{t("history.status")}</TableHead>
          <TableHead>{t("history.turns")}</TableHead>
          <TableHead>{t("history.tokens")}</TableHead>
          <TableHead>{t("history.created")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {goals.map((g) => (
          <TableRow key={g.id} data-testid="goals-history-row">
            <TableCell className="max-w-xs truncate" title={g.safeObjective}>
              {g.safeObjective}
            </TableCell>
            <TableCell>{t(`status.${g.status}`)}</TableCell>
            <TableCell>{g.turnsUsed}</TableCell>
            <TableCell>{g.tokensUsed.toLocaleString()}</TableCell>
            <TableCell>{new Date(g.createdAt).toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
