"use client"

/**
 * Browse + CRUD the cases inside a dataset (the piece the old dashboard
 * lacked). Lists cases via `useEvalCases`, opens {@link CaseEditor} for
 * add/edit, and deletes via the Dexie CRUD. Mutations bump the dataset version
 * inside `lib/db/eval-datasets`.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { addCase, updateCase, deleteCase } from "@/lib/db/eval-datasets"
import { useEvalCases } from "@/hooks/eval/use-eval-data"
import { CaseEditor, type CaseEditorValue } from "./case-editor"
import type { EvalCase } from "@/types/eval/eval"

export function CaseList({ datasetId }: { datasetId: string }) {
  const t = useTranslations("eval")
  const cases = useEvalCases(datasetId)
  const [editing, setEditing] = useState<string | "new" | null>(null)

  const handleSave = useCallback(
    async (value: CaseEditorValue, caseId?: string) => {
      if (caseId) {
        await updateCase(caseId, value)
      } else {
        await addCase(datasetId, value)
      }
      setEditing(null)
    },
    [datasetId]
  )

  return (
    <div className="flex flex-col gap-2" data-testid="case-list">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("case.heading", { count: cases.length })}</h3>
        <Button size="sm" variant="ghost" onClick={() => setEditing("new")}>
          <PlusIcon className="size-4" />
          {t("case.add")}
        </Button>
      </div>

      {editing === "new" && (
        <CaseEditor onSave={(v) => void handleSave(v)} onCancel={() => setEditing(null)} />
      )}

      {cases.length === 0 && editing !== "new" ? (
        <p className="text-muted-foreground text-sm">{t("case.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {cases.map((c: EvalCase) => (
            <li key={c.id} className="motion-safe:animate-in motion-safe:fade-in rounded-md border">
              {editing === c.id ? (
                <CaseEditor
                  initial={c}
                  onSave={(v) => void handleSave(v, c.id)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex items-center justify-between gap-2 p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{c.input}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[10px]">
                        {c.capability}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {c.source}
                      </Badge>
                      {c.split && (
                        <Badge variant="outline" className="text-[10px]">
                          {c.split}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("case.edit")}
                      onClick={() => setEditing(c.id)}
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("case.delete")}
                      onClick={() => void deleteCase(c.id)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
