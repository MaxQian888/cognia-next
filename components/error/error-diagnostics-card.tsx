"use client"

/**
 * Inline system-diagnostics card for the error page.
 *
 * Surfaces context that was previously only reachable via the crash-log export:
 * app version, platform / OS, live connectivity, locale, current route, runtime
 * host, and the resolved error category. Rendered as a collapsible so it stays
 * out of the way until a user (or support agent) wants it.
 *
 * Provider-agnostic by design: it takes resolved `locale` / `pathname` /
 * `categoryLabel` as props rather than calling `useTranslations` / `usePathname`,
 * so it also works in the `staticLocale="en"` global-error path where neither
 * provider is mounted. Only `useNetworkStatus` is used internally, which needs
 * no React context.
 */

import { useEffect, useState } from "react"
import { ChevronDown, Wifi, WifiOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import type { LocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { cn } from "@/lib/utils"

export interface ErrorDiagnosticsCopy {
  title: string
  appVersion: string
  platform: string
  osVersion: string
  runtime: string
  online: string
  offline: string
  locale: string
  route: string
  category: string
  runtimeDesktop: string
  runtimeBrowser: string
}

export interface ErrorDiagnosticsCardProps {
  copy: ErrorDiagnosticsCopy
  categoryLabel: string
  locale: string
  pathname: string | null
  /** Test seam — defaults to the real diagnostics reader. */
  getDiagnostics?: typeof getLocalRuntimeDiagnostics
  className?: string
}

const EMPTY = "—"

function asText(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "number") return String(value)
  return EMPTY
}

export function ErrorDiagnosticsCard({
  copy,
  categoryLabel,
  locale,
  pathname,
  getDiagnostics = getLocalRuntimeDiagnostics,
  className,
}: ErrorDiagnosticsCardProps) {
  const { status } = useNetworkStatus()
  const [diagnostics, setDiagnostics] = useState<LocalRuntimeDiagnostics | null>(null)

  useEffect(() => {
    if (typeof window === "undefined") return
    let cancelled = false
    void getDiagnostics()
      .then((result) => {
        if (!cancelled) setDiagnostics(result)
      })
      .catch(() => {
        /* diagnostics are best-effort — leave fields as "—" */
      })
    return () => {
      cancelled = true
    }
  }, [getDiagnostics])

  const isTauri = diagnostics?.isTauri === true
  const rows: Array<{ key: string; label: string; value: React.ReactNode }> = [
    {
      key: "category",
      label: copy.category,
      value: <Badge variant="secondary">{categoryLabel}</Badge>,
    },
    { key: "appVersion", label: copy.appVersion, value: asText(diagnostics?.appVersion) },
    { key: "platform", label: copy.platform, value: asText(diagnostics?.platform) },
    { key: "osVersion", label: copy.osVersion, value: asText(diagnostics?.osVersion) },
    {
      key: "runtime",
      label: copy.runtime,
      value: diagnostics ? (isTauri ? copy.runtimeDesktop : copy.runtimeBrowser) : EMPTY,
    },
    {
      key: "online",
      label: copy.online,
      value: (
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            status.connected ? "text-success" : "text-destructive"
          )}
          data-testid="error-diagnostics-online"
        >
          {status.connected ? (
            <Wifi className="size-3.5" aria-hidden="true" />
          ) : (
            <WifiOff className="size-3.5" aria-hidden="true" />
          )}
          {status.connected ? copy.online : copy.offline}
        </span>
      ),
    },
    { key: "locale", label: copy.locale, value: asText(locale) },
    { key: "route", label: copy.route, value: asText(pathname) },
  ]

  return (
    <Collapsible
      className={cn("w-full rounded-md border bg-muted/30 text-left", className)}
      data-testid="error-diagnostics-card"
    >
      <CollapsibleTrigger
        className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
        data-testid="error-diagnostics-toggle"
      >
        <span>{copy.title}</span>
        <ChevronDown
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 pb-3 text-xs">
          {rows.map((row) => (
            <div
              key={row.key}
              className="contents"
              data-testid={`error-diagnostics-row-${row.key}`}
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right font-mono break-all">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}
