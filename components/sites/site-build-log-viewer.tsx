"use client"

/**
 * What a build actually printed.
 *
 * `runConfinedSiteBuild` has always returned the full stdout and stderr of the
 * install and build phases. On success both were discarded; on failure only
 * `stderr.trim() || stdout.trim()` survived as an Error message, so the one
 * artifact that explains a broken build was the one thing the console could
 * never show. `lib/sites/build-log.ts` now stores it, trimmed head-and-tail
 * and credential-redacted, and this reads it back.
 *
 * The dialog, not an inline panel: this is hundreds of kilobytes of monospace
 * inside a resizable pane that also has to render the version list.
 */
import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, ScrollTextIcon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useCopy } from "@/hooks/ui"
import { useSiteBuildLogs } from "@/hooks/sites/use-site-build-logs"
import { cn } from "@/lib/utils"
import type { SiteBuildLogRow } from "@/types/sites"

export interface SiteBuildLogViewerProps {
  versionId: string
  /** Rendered on the trigger, so the row can say which version this is. */
  label: string
}

export function SiteBuildLogViewer({ versionId, label }: SiteBuildLogViewerProps) {
  const t = useTranslations("sites")
  const [open, setOpen] = useState(false)
  // The query is keyed on null until the dialog opens, so a closed viewer never
  // reads a byte.
  const { logs, loading } = useSiteBuildLogs(open ? versionId : null)
  const [phase, setPhase] = useState<SiteBuildLogRow["phase"] | null>(null)
  const [stderrOnly, setStderrOnly] = useState(false)
  const { copy, copied } = useCopy()

  const active = logs.find((row) => row.phase === phase) ?? logs[0]
  const body = active
    ? stderrOnly
      ? active.stderr || t("buildLog.noStderr")
      : [active.stdout || t("buildLog.noStdout"), active.stderr].filter(Boolean).join("\n")
    : ""

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="xs" variant="ghost" data-testid={`site-build-log-${versionId}`}>
          <ScrollTextIcon aria-hidden className="size-3.5" />
          {t("buildLog.open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("buildLog.title")}</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <Skeleton className="h-64 w-full rounded-panel" data-testid="site-build-log-loading" />
        ) : logs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("buildLog.empty")}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                value={active?.phase ?? ""}
                onValueChange={(value) => value && setPhase(value as SiteBuildLogRow["phase"])}
                variant="outline"
                size="sm"
              >
                {logs.map((row) => (
                  <ToggleGroupItem key={row.phase} value={row.phase}>
                    {t(`buildLog.phase.${row.phase}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>

              {active ? (
                <>
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-normal tabular-nums",
                      active.exitCode !== 0 && "border-destructive/40 text-destructive"
                    )}
                  >
                    {t("buildLog.exitCode", { code: active.exitCode })}
                  </Badge>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t("buildLog.duration", { seconds: active.durationSeconds.toFixed(1) })}
                  </span>
                  {active.timedOut ? (
                    <Badge variant="outline" className="border-warning/40 font-normal text-warning">
                      {t("buildLog.timedOut")}
                    </Badge>
                  ) : null}
                </>
              ) : null}

              <div className="ml-auto flex items-center gap-1.5">
                <Switch
                  id="site-build-log-stderr"
                  checked={stderrOnly}
                  onCheckedChange={setStderrOnly}
                />
                <Label htmlFor="site-build-log-stderr" className="text-xs">
                  {t("buildLog.stderrOnly")}
                </Label>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("buildLog.copy")}
                  disabled={!body}
                  onClick={() => void copy(body)}
                >
                  {copied ? (
                    <CheckIcon aria-hidden className="size-4 text-success" />
                  ) : (
                    <CopyIcon aria-hidden className="size-4" />
                  )}
                </Button>
              </div>
            </div>

            {active ? (
              <p
                className="truncate font-mono text-xs text-muted-foreground"
                title={active.argv.join(" ")}
              >
                {t("buildLog.command")}: {active.argv.join(" ")}
              </p>
            ) : null}

            {active?.truncated ? (
              <p className="text-xs text-warning" data-testid="site-build-log-truncated">
                {t("buildLog.truncated")}
              </p>
            ) : null}

            <Surface
              layer="base"
              radius="panel"
              className="max-h-[50vh] overflow-auto border p-3"
              data-testid="site-build-log-body"
            >
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">{body}</pre>
            </Surface>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
