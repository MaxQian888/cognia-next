"use client"

/**
 * Dataset detail pane: header (name / version / capability / gate badge) +
 * actions (Import / Export / Gate / Run — Import, Gate and Run open real
 * Dialogs), and a Cases | Runs | Versions segmented body. Opening a run swaps
 * the Runs segment to {@link RunDetail}.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  MoreHorizontalIcon,
  PlayIcon,
  UploadIcon,
  HistoryIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalDataset } from "@/types/eval/eval"
import { toJsonl, toCsv } from "@/lib/ai/eval/export"
import { useEvalCases } from "@/hooks/eval/use-eval-data"
import { CaseList } from "./case-list"
import { ImportDialog } from "./import-dialog"
import { RunConfigDialog, type RunConfigOptions } from "./run-config-dialog"
import { VersionHistory } from "./version-history"
import { RunsList } from "./runs-list"
import { RunDetail } from "./run-detail"
import { GateConfigSection } from "./gate-config-section"

type DialogKind = "none" | "import" | "run" | "gate"
type Segment = "cases" | "runs" | "versions"

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
  const [dialog, setDialog] = useState<DialogKind>("none")
  const [segment, setSegment] = useState<Segment>("cases")
  const [openRunId, setOpenRunId] = useState<string | null>(null)

  const SEGMENTS: { key: Segment; label: string }[] = [
    { key: "cases", label: t("detail.segments.cases") },
    { key: "runs", label: t("detail.segments.runs") },
    { key: "versions", label: t("detail.segments.versions") },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="dataset-detail">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-base font-semibold">{dataset.name}</h2>
          <Badge variant="secondary">{t("datasets.version", { version: dataset.version })}</Badge>
          <Badge variant="outline">{dataset.capability}</Badge>
          {dataset.gate && (
            <Badge variant="outline" className="gap-1">
              <ShieldCheckIcon className="size-3" />
              {t("detail.gateConfigured")}
            </Badge>
          )}
        </div>
        {/* Run is the primary action; the rest collapse into an overflow menu.
            Five side-by-side buttons plus three badges wrapped onto three rows
            in the 320px detail pane. */}
        <div className="flex shrink-0 gap-1">
          <Button size="sm" onClick={() => setDialog("run")}>
            <PlayIcon className="size-4" />
            {t("detail.run")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" aria-label={t("detail.moreActions")}>
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setDialog("import")}>
                <UploadIcon className="size-4" />
                {t("detail.import")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  download(`${dataset.name}.jsonl`, toJsonl(cases), "application/jsonl")
                }
              >
                <DownloadIcon className="size-4" />
                {t("detail.exportJsonl")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => download(`${dataset.name}.csv`, toCsv(cases), "text/csv")}
              >
                <DownloadIcon className="size-4" />
                {t("detail.exportCsv")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog("gate")}>
                <ShieldCheckIcon className="size-4" />
                {t("detail.gate")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b pb-2">
        {SEGMENTS.map((s) => (
          <Button
            key={s.key}
            size="sm"
            variant={segment === s.key ? "secondary" : "ghost"}
            aria-pressed={segment === s.key}
            onClick={() => {
              setSegment(s.key)
              setOpenRunId(null)
            }}
          >
            {s.key === "versions" && <HistoryIcon className="size-4" />}
            {s.label}
          </Button>
        ))}
      </div>

      <div
        key={segment}
        className="motion-safe:animate-in motion-safe:fade-in min-h-0 flex-1 overflow-y-auto"
      >
        {segment === "cases" ? (
          <CaseList datasetId={dataset.id} />
        ) : segment === "runs" ? (
          openRunId ? (
            <RunDetail runId={openRunId} gate={dataset.gate} onBack={() => setOpenRunId(null)} />
          ) : (
            <RunsList datasetId={dataset.id} gate={dataset.gate} onOpenRun={setOpenRunId} />
          )
        ) : (
          <VersionHistory datasetId={dataset.id} />
        )}
      </div>

      <Dialog open={dialog === "import"} onOpenChange={(open) => !open && setDialog("none")}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("detail.import")}</DialogTitle>
          </DialogHeader>
          <ImportDialog
            datasetId={dataset.id}
            capability={dataset.capability}
            {...(dataset.defaultGrading ? { defaultGrading: dataset.defaultGrading } : {})}
            onClose={() => setDialog("none")}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "run"} onOpenChange={(open) => !open && setDialog("none")}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("detail.run")}</DialogTitle>
          </DialogHeader>
          <RunConfigDialog
            datasetId={dataset.id}
            appSettings={appSettings}
            {...(runOptions ? { options: runOptions } : {})}
            onClose={() => setDialog("none")}
            onComplete={() => setSegment("runs")}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "gate"} onOpenChange={(open) => !open && setDialog("none")}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("detail.gate")}</DialogTitle>
          </DialogHeader>
          <GateConfigSection datasetId={dataset.id} gate={dataset.gate} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
