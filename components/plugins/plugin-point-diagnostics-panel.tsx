"use client"

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, AlertCircleIcon, AlertTriangleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import {
  clearAllPluginPointDiagnostics as defaultClearAll,
  clearPluginPointDiagnostics as defaultClearForPlugin,
  getAllPluginPointDiagnostics as defaultGetDiagnostics,
  subscribePluginPointDiagnostics as defaultSubscribe,
} from "@/lib/plugin/contracts/diagnostics-store"
import type { PluginPointDiagnostic } from "@/lib/plugin/contracts/plugin-points"

export type DiagnosticsSeverityFilter = "all" | "errors" | "warnings"

export interface PluginPointDiagnosticsPanelProps {
  /** Inject for tests; falls back to the real store API. */
  getDiagnostics?: () => Record<string, PluginPointDiagnostic[]>
  subscribe?: (listener: () => void) => () => void
  clearForPlugin?: (pluginId: string) => void
  clearAll?: () => void
}

const EMPTY_SNAPSHOT: Record<string, PluginPointDiagnostic[]> = Object.freeze({})

function filterBySeverity(
  diagnostics: PluginPointDiagnostic[],
  severity: DiagnosticsSeverityFilter
): PluginPointDiagnostic[] {
  if (severity === "all") return diagnostics
  if (severity === "errors") return diagnostics.filter((d) => d.severity === "error")
  return diagnostics.filter((d) => d.severity === "warning")
}

function hasAnyError(diagnostics: PluginPointDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error")
}

export function PluginPointDiagnosticsPanel({
  getDiagnostics = defaultGetDiagnostics,
  subscribe = defaultSubscribe,
  clearForPlugin = defaultClearForPlugin,
  clearAll = defaultClearAll,
}: PluginPointDiagnosticsPanelProps = {}) {
  const t = useTranslations("settings.plugins.audit.diagnostics")

  const stableSubscribe = useCallback((listener: () => void) => subscribe(listener), [subscribe])
  const stableGet = useCallback(() => getDiagnostics(), [getDiagnostics])

  const all = useSyncExternalStore(stableSubscribe, stableGet, () => EMPTY_SNAPSHOT)

  const [severity, setSeverity] = useState<DiagnosticsSeverityFilter>("all")
  const [confirmOpen, setConfirmOpen] = useState(false)

  const groups = useMemo(() => {
    return Object.entries(all)
      .map(([pluginId, diagnostics]) => ({
        pluginId,
        all: diagnostics,
        visible: filterBySeverity(diagnostics, severity),
        defaultOpen: hasAnyError(diagnostics),
      }))
      .filter((g) => g.visible.length > 0)
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  }, [all, severity])

  const totalCount = useMemo(() => groups.reduce((sum, g) => sum + g.visible.length, 0), [groups])

  const isEmpty = totalCount === 0

  const handleConfirmClearAll = () => {
    clearAll()
    setConfirmOpen(false)
  }

  return (
    <Card
      className="gap-4 border-border/70 bg-card/60 p-4 py-4 shadow-sm"
      data-testid="plugin-point-diagnostics-panel"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold tracking-tight">{t("title")}</h3>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{t("hint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            className="bg-muted/60 p-1"
            type="single"
            size="sm"
            value={severity}
            onValueChange={(v) => {
              if (v === "all" || v === "errors" || v === "warnings") setSeverity(v)
            }}
            aria-label={t("severityFilterAria")}
          >
            <ToggleGroupItem value="all" aria-label={t("filterAll")}>
              {t("filterAll")}
            </ToggleGroupItem>
            <ToggleGroupItem value="errors" aria-label={t("filterErrors")}>
              {t("filterErrors")}
            </ToggleGroupItem>
            <ToggleGroupItem value="warnings" aria-label={t("filterWarnings")}>
              {t("filterWarnings")}
            </ToggleGroupItem>
          </ToggleGroup>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={Object.keys(all).length === 0}
                data-testid="diagnostics-clear-all"
              >
                {t("clearAll")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("clearAllConfirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("clearAllConfirm")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={handleConfirmClearAll}>
                  {t("confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {isEmpty ? (
        <p
          className="rounded-lg border border-dashed bg-muted/15 p-4 text-center text-sm text-muted-foreground"
          data-testid="diagnostics-empty"
        >
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => (
            <li key={group.pluginId}>
              <DiagnosticGroup
                pluginId={group.pluginId}
                diagnostics={group.visible}
                defaultOpen={group.defaultOpen}
                onClear={() => clearForPlugin(group.pluginId)}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

interface DiagnosticGroupProps {
  pluginId: string
  diagnostics: PluginPointDiagnostic[]
  defaultOpen: boolean
  onClear: () => void
}

function DiagnosticGroup({ pluginId, diagnostics, defaultOpen, onClear }: DiagnosticGroupProps) {
  const t = useTranslations("settings.plugins.audit.diagnostics")
  const [open, setOpen] = useState(defaultOpen)
  const errorCount = diagnostics.filter((d) => d.severity === "error").length

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 bg-card">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 text-left flex-1"
            aria-expanded={open}
            data-testid={`diagnostics-group-trigger-${pluginId}`}
          >
            {open ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            <span className="font-mono text-xs">{pluginId}</span>
            <Badge variant={errorCount > 0 ? "destructive" : "secondary"} className="text-[10px]">
              {t("countBadge", { count: diagnostics.length })}
            </Badge>
          </button>
        </CollapsibleTrigger>
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
          data-testid={`diagnostics-clear-${pluginId}`}
        >
          {t("clearForPlugin")}
        </Button>
      </div>
      <CollapsibleContent className="px-3 py-2 space-y-1.5">
        {diagnostics.map((d, idx) => (
          <DiagnosticRow key={`${d.code}-${d.pointId}-${idx}`} diagnostic={d} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function DiagnosticRow({ diagnostic }: { diagnostic: PluginPointDiagnostic }) {
  const Icon = diagnostic.severity === "error" ? AlertCircleIcon : AlertTriangleIcon
  const iconClass =
    diagnostic.severity === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-500"

  return (
    <div className="flex items-start gap-2 text-xs" data-testid="diagnostics-row">
      <Icon className={`size-3.5 mt-0.5 shrink-0 ${iconClass}`} />
      <div className="space-y-0.5 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-[10px] bg-muted px-1 rounded">{diagnostic.code}</code>
          <code className="font-mono text-[10px] text-muted-foreground">{diagnostic.pointId}</code>
        </div>
        <p className="text-foreground">
          {diagnostic.hint ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help underline decoration-dotted underline-offset-2">
                  {diagnostic.message}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">
                <p className="text-xs">{diagnostic.hint}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            diagnostic.message
          )}
        </p>
      </div>
    </div>
  )
}
