"use client"

/**
 * The change a delegate run produced, file by file (ADR-0188 B4, DEL-04).
 *
 * A delegate patch is whole-file writes and deletes against one base revision
 * (`DelegatePatch`), so each file is rendered in the source-control diff
 * viewer — the same Monaco editor the Source Control pane uses — with the
 * workspace's current content on the left.
 *
 * What the header says about that comparison is load-bearing. The left side is
 * the workspace as it is NOW, which is the patch's base only while the
 * workspace has not moved. When it has, the banner says so: a diff labelled as
 * "against the base" that is actually against something else would make a
 * conflict look like a clean change. A file the device could not read is
 * marked too, because an all-added diff otherwise reads as "this file is new".
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, DownloadIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DiffViewer } from "@/components/source-control/diff-viewer"
import { cn } from "@/lib/utils"

import { RunDetailRow } from "./fusion-run-details"
import type { DelegatePatchView as DelegatePatchModel } from "./delegate-review-model"

const warnText = "text-amber-600 dark:text-amber-400"

export interface DelegatePatchViewProps {
  patch: DelegatePatchModel | null
  /** Offered only when the patch document is still stored. */
  onDownload?: () => void
  downloading?: boolean
}

export function DelegatePatchView({ patch, onDownload, downloading }: DelegatePatchViewProps) {
  const t = useTranslations("routerFusionDelegate.patch")

  if (!patch) {
    return (
      <section className="space-y-1" data-testid="delegate-patch">
        <h4 className="text-xs font-medium">{t("title")}</h4>
        <p className="text-[11px] text-muted-foreground">{t("none")}</p>
      </section>
    )
  }

  const comparison =
    patch.comparedRevision === null
      ? { text: t("comparedUnavailable"), warn: true }
      : patch.comparedAtBase
        ? { text: t("comparedNow"), warn: false }
        : {
            text: t("comparedMoved", {
              revision: patch.comparedRevision,
              base: patch.baseRevision,
            }),
            warn: true,
          }

  return (
    <section className="space-y-2 text-xs" data-testid="delegate-patch">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-medium">{t("title")}</h4>
          <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
            {t("files", { count: patch.fileCount })}
          </Badge>
        </div>
        {onDownload && patch.document !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={downloading}
            onClick={onDownload}
          >
            <DownloadIcon className="size-3" aria-hidden />
            {t("download")}
          </Button>
        ) : null}
      </div>

      <dl className="space-y-1.5">
        <RunDetailRow label={t("base")}>
          <span className="font-mono text-[10px]">{patch.baseRevision}</span>
        </RunDetailRow>
        {patch.resultRevision ? (
          <RunDetailRow label={t("result")}>
            <span className="font-mono text-[10px]">{patch.resultRevision}</span>
          </RunDetailRow>
        ) : null}
        <RunDetailRow label={t("delivery")}>{t(`deliveryValue.${patch.delivery}`)}</RunDetailRow>
        <RunDetailRow label={t("workspace")}>
          {patch.appliedRevision ? (
            <span data-testid="delegate-patch-applied">
              {t("applied", { revision: patch.appliedRevision })}
            </span>
          ) : (
            <span className="text-muted-foreground">{t("notApplied")}</span>
          )}
        </RunDetailRow>
      </dl>

      {patch.document === null ? (
        <p
          role="status"
          className={cn("text-[11px]", warnText)}
          data-testid="delegate-patch-expired"
        >
          {t("expired")}
        </p>
      ) : (
        <>
          <p className={cn("flex items-start gap-1.5 text-[11px]", comparison.warn && warnText)}>
            {comparison.warn ? (
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            ) : null}
            {comparison.text}
          </p>
          <ul className="space-y-2">
            {patch.files.map((file) => (
              <li key={file.path} className="space-y-1" data-testid="delegate-patch-file">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-all font-mono text-[11px]">{file.path}</span>
                  <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                    {t(`file.${file.action}`)}
                  </Badge>
                  {file.baseState === "absent" ? (
                    <span className="text-[10px] text-muted-foreground">
                      {t("file.baseAbsent")}
                    </span>
                  ) : null}
                  {file.baseState === "unavailable" ? (
                    <span className={cn("text-[10px]", warnText)}>{t("file.baseUnavailable")}</span>
                  ) : null}
                  {file.unchanged ? (
                    <span className="text-[10px] text-muted-foreground">{t("unchanged")}</span>
                  ) : null}
                </div>
                {file.action === "write" ? (
                  <div className="h-72 overflow-hidden rounded border">
                    <DiffViewer
                      staged={false}
                      readOnly
                      diff={{
                        path: file.path,
                        oldContent: file.baseContent ?? "",
                        newContent: file.newContent ?? "",
                        hunks: [],
                        isBinary: false,
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
