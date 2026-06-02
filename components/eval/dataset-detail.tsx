"use client"

/**
 * Dataset detail pane: header (name / version / capability) + actions
 * (Import, Export JSONL/CSV, Versions, Run) and the embedded {@link CaseList}.
 * The action panels (import / run-config / versions) render inline below the
 * header so the whole flow stays jsdom-friendly (no Radix Dialog).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, PlayIcon, UploadIcon, HistoryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { AppSettings } from "@/lib/claude/types"
import type { EvalDataset } from "@/types/eval/eval"
import { toJsonl, toCsv } from "@/lib/ai/eval/export"
import { useEvalCases } from "@/hooks/eval/use-eval-data"
import { CaseList } from "./case-list"
import { ImportDialog } from "./import-dialog"
import { RunConfigDialog, type RunConfigOptions } from "./run-config-dialog"
import { VersionHistory } from "./version-history"

type Panel = "none" | "import" | "run" | "versions"

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export interface DatasetDetailProps {
  dataset: EvalDataset
  appSettings: AppSettings | null
  runOptions?: RunConfigOptions
}

export function DatasetDetail({ dataset, appSettings, runOptions }: DatasetDetailProps) {
  const t = useTranslations("eval")
  const cases = useEvalCases(dataset.id)
  const [panel, setPanel] = useState<Panel>("none")

  return (
    <div className="flex flex-col gap-3" data-testid="dataset-detail">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{dataset.name}</h2>
          <Badge variant="secondary">{t("datasets.version", { version: dataset.version })}</Badge>
          <Badge variant="outline">{dataset.capability}</Badge>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPanel(panel === "import" ? "none" : "import")}
          >
            <UploadIcon className="size-4" />
            {t("detail.import")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => download(`${dataset.name}.jsonl`, toJsonl(cases), "application/jsonl")}
          >
            <DownloadIcon className="size-4" />
            {t("detail.exportJsonl")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => download(`${dataset.name}.csv`, toCsv(cases), "text/csv")}
          >
            <DownloadIcon className="size-4" />
            {t("detail.exportCsv")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPanel(panel === "versions" ? "none" : "versions")}
          >
            <HistoryIcon className="size-4" />
            {t("detail.versions")}
          </Button>
          <Button size="sm" onClick={() => setPanel(panel === "run" ? "none" : "run")}>
            <PlayIcon className="size-4" />
            {t("detail.run")}
          </Button>
        </div>
      </header>

      {panel === "import" && (
        <ImportDialog
          datasetId={dataset.id}
          capability={dataset.capability}
          onClose={() => setPanel("none")}
        />
      )}
      {panel === "run" && (
        <RunConfigDialog
          datasetId={dataset.id}
          appSettings={appSettings}
          {...(runOptions ? { options: runOptions } : {})}
          onClose={() => setPanel("none")}
        />
      )}
      {panel === "versions" && <VersionHistory datasetId={dataset.id} />}

      <CaseList datasetId={dataset.id} />
    </div>
  )
}
